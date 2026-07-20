// buildSnapshot(db, installationId) — SPEC §7.5. Reads the active route revisions, keys,
// offerings, profiles, policies and credentials for an installation and emits the compact §7
// snapshot: profiles (host→profile), keys (hex(keyed_hash)→key), routes
// (`${profileId}:${path}`→targets with ciphertext + wrappedDek + authInject), offerings,
// policies. Canonicalizes and stamps `contentHash`. The result is a `ports.Snapshot` superset
// (§7.1 offerings/policies added), so gateway-core loads and routes it unchanged.
import type { AuthInject, Snapshot, SnapshotKey, SnapshotRoute, SnapshotTarget } from "@manifold/ports";
import type { Database } from "@manifold/database";
import { randomBytes } from "node:crypto";
import { computeContentHash } from "./canonical.js";
import * as q from "./db.js";
import type { PgSql } from "./db.js";
import type { ConfigOffering, ConfigPolicy, ConfigSnapshot } from "./types.js";

/** Prefixed-ULID-ish id (§6.1 convention: prefixed text). Monotonic-ish for readability. */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(9).toString("hex")}`;
}

/** endpoint_kind → request pathname gateway-core resolves against (resolveRoute: `${profile}:${path}`). */
export function pathForKind(kind: string): string {
  switch (kind) {
    case "chat":
      return "/v1/chat/completions";
    case "responses":
      return "/v1/responses";
    case "embeddings":
      return "/v1/embeddings";
    default:
      return `/v1/${kind}`;
  }
}

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  "google-vertex": "https://us-central1-aiplatform.googleapis.com",
  google: "https://generativelanguage.googleapis.com",
  mistral: "https://api.mistral.ai",
};

function defaultBaseUrl(provider: string): string {
  return PROVIDER_BASE_URLS[provider] ?? "https://api.openai.com";
}

/** Fresh provider-auth injection template per provider (§2.8/§14.4). */
export function authInjectFor(provider: string): AuthInject {
  if (provider === "anthropic") {
    return { headers: { "x-api-key": "${secret}", "anthropic-version": "2023-06-01" } };
  }
  return { headers: { authorization: "Bearer ${secret}" } };
}

function toIso(d: Date | null): string | null {
  return d ? new Date(d).toISOString() : null;
}

function scopesToArray(scopes: unknown): string[] {
  if (Array.isArray(scopes)) return scopes.map(String);
  if (scopes && typeof scopes === "object") return Object.keys(scopes as object);
  return [];
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Build the `keys` section: hex(keyed_hash) → SnapshotKey (§7.2). Reused by keyOnlyPublish. */
export async function buildKeysSection(
  sql: PgSql,
  profileIds: string[],
): Promise<Record<string, SnapshotKey>> {
  const keyRows = await q.readVirtualKeys(sql, profileIds);
  const keys: Record<string, SnapshotKey> = {};
  for (const k of keyRows) {
    const hex = Buffer.from(k.keyed_hash).toString("hex");
    keys[hex] = {
      id: k.id,
      profileId: k.profile_id,
      scopes: scopesToArray(k.scopes),
      allowedAppIds: Array.isArray(k.allowed_app_ids) ? (k.allowed_app_ids as string[]) : [],
      budgetAccountId: k.budget_account_id,
      expiresAt: toIso(k.expires_at),
      revoked: k.revoked_at != null,
    };
  }
  return keys;
}

/** Data assembled once, shared between full build and targeted (key-only) rebuilds. */
export interface BuildInputs {
  workspaceId: string;
  profileIds: string[];
}

/**
 * Core builder over an open sql client. `installation` and `workspaceId` are resolved by the
 * caller (buildSnapshot) so transactional callers can reuse it.
 */
export async function assembleSnapshot(
  sql: PgSql,
  installationId: string,
  workspaceId: string,
): Promise<ConfigSnapshot> {
  // 1. profiles: host → profile
  const profileRows = await q.readProfiles(sql, installationId);
  const profiles: Snapshot["profiles"] = {};
  const profileIds: string[] = [];
  const policyRevisionIds = new Set<string>();
  for (const p of profileRows) {
    const host = p.hostname.trim().toLowerCase();
    profiles[host] = {
      id: p.id,
      mode: p.mode,
      policyRevision: p.policy_revision_id,
      defaultRouteSet: null,
    };
    profileIds.push(p.id);
    if (p.policy_revision_id) policyRevisionIds.add(p.policy_revision_id);
  }

  // 2. keys: hex(keyed_hash) → key
  const keys = await buildKeysSection(sql, profileIds);

  // 3. routes + targets + offerings/credmap
  const routes: Record<string, SnapshotRoute> = {};
  const offerings: Record<string, ConfigOffering> = {};
  const routeRows = await q.readRoutes(sql, installationId);
  for (const route of routeRows) {
    if (!route.active_revision_id) continue;
    const rev = await q.readRouteRevision(sql, route.active_revision_id);
    if (!rev) continue;
    const targetRows = await q.readTargets(sql, rev.id);
    const targets: SnapshotTarget[] = [];
    for (const t of targetRows) {
      const cred = await q.readCredential(sql, t.provider_credential_id);
      if (!cred) continue;
      const dek = await q.readDek(sql, cred.dek_id);
      const offering = await q.readOffering(sql, t.offering_id);
      const baseUrl = t.base_url ?? cred.base_url ?? defaultBaseUrl(cred.provider);
      const allowedHosts = Array.isArray(cred.allowed_hosts)
        ? (cred.allowed_hosts as string[]).slice()
        : [];
      const host = hostFromUrl(baseUrl);
      if (host && !allowedHosts.includes(host)) allowedHosts.push(host);
      targets.push({
        offeringId: t.offering_id,
        credentialId: cred.id,
        dekId: cred.dek_id,
        credentialCiphertext: Buffer.from(cred.encrypted_secret).toString("base64"),
        wrappedDek: dek ? Buffer.from(dek.wrapped_dek).toString("base64") : "",
        weight: t.weight,
        priority: t.priority,
        baseUrl,
        region: t.region ?? offering?.region ?? null,
        allowedHosts,
        authInject: authInjectFor(cred.provider),
        secretEnv: null,
      });
      // offerings section (budget eligibility, §7.1)
      if (offering && !offerings[offering.id]) {
        const price = offering.active_price_revision_id
          ? await q.readPrice(sql, offering.active_price_revision_id)
          : null;
        offerings[offering.id] = {
          provider: offering.provider,
          providerModelId: offering.provider_model_id,
          adapterRevision: offering.adapter_revision,
          region: offering.region,
          priceRevisionId: offering.active_price_revision_id,
          priceFidelity: price?.fidelity ?? null,
          capabilities: offering.capabilities ?? null,
          baseUrl,
        };
      }
    }

    const timeout = rev.timeout_policy ?? {};
    const timeoutMs =
      typeof timeout["overall_ms"] === "number"
        ? (timeout["overall_ms"] as number)
        : typeof timeout["overallMs"] === "number"
          ? (timeout["overallMs"] as number)
          : 60_000;

    const snapRoute: SnapshotRoute = {
      routeId: route.id,
      revision: rev.id,
      mode: rev.mode,
      targets,
      timeoutMs,
      capturePolicyId: `cap:${route.id}`,
    };
    // Associate the route with every profile on this installation. gateway-core resolves by
    // `${profileId}:${path}` (resolveRoute), so we emit one entry per profile.
    const path = pathForKind(route.endpoint_kind);
    for (const profileId of profileIds) {
      routes[`${profileId}:${path}`] = snapRoute;
    }
  }

  // 4. policies: policy revision id → entitlements + constraints
  const policies: Record<string, ConfigPolicy> = {};
  for (const prid of policyRevisionIds) {
    const [ents, reqs, dh] = await Promise.all([
      q.readEntitlements(sql, prid),
      q.readRequestConstraints(sql, prid),
      q.readDataHandling(sql, prid),
    ]);
    const entitlementIndex: Record<string, string[]> = {};
    for (const e of ents) {
      if (e.effect !== "allow") continue;
      const subject = `${e.subject_kind}:${e.subject_ref ?? "*"}`;
      const model = e.offering_id ?? e.canonical_model_id;
      if (!model) continue;
      (entitlementIndex[subject] ??= []).push(model);
    }
    policies[prid] = {
      entitlements: ents.map((e) => ({
        subjectKind: e.subject_kind,
        subjectRef: e.subject_ref,
        canonicalModelId: e.canonical_model_id,
        offeringId: e.offering_id,
        effect: e.effect,
      })),
      entitlementIndex,
      requestConstraints: reqs.map((r) => ({
        param: r.param,
        maxValue: r.max_value,
        minValue: r.min_value,
        onViolation: r.on_violation,
      })),
      dataHandling: dh.map((d) => ({
        captureMode: d.capture_mode,
        redaction: d.redaction ?? null,
        allowedRegions: d.allowed_regions ?? null,
      })),
    };
  }

  const snapshot: ConfigSnapshot = {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId,
      revision: genId("cfgrev"),
      contentHash: "",
      builtAt: new Date().toISOString(),
      signature: "",
      signingKeyId: "",
    },
    profiles,
    keys,
    routes,
    offerings,
    policies,
  };
  snapshot.meta.contentHash = computeContentHash(snapshot);
  return snapshot;
}

/**
 * Public entrypoint (§7.5). Resolves the installation → workspace, then assembles the compact
 * snapshot. The returned snapshot is unsigned (`meta.signature === ""`); call `signSnapshot`.
 */
export async function buildSnapshot(
  db: Database,
  installationId: string,
): Promise<ConfigSnapshot> {
  const sql = q.client(db);
  const inst = await q.readInstallation(sql, installationId);
  if (!inst) throw new Error(`installation not found: ${installationId}`);
  return assembleSnapshot(sql, installationId, inst.workspace_id);
}
