// buildSnapshot(db, installationId) — SPEC §7.5. Reads the active route revisions, keys,
// offerings, profiles, policies and credentials for an installation and emits the compact §7
// snapshot: profiles (host→profile), keys (hex(keyed_hash)→key), routes
// (`${profileId}:${path}`→targets with ciphertext + wrappedDek + authInject), offerings,
// policies. Canonicalizes and stamps `contentHash`. The result is a `ports.Snapshot` superset
// (§7.1 offerings/policies added), so gateway-core loads and routes it unchanged.
import type {
  AuthInject,
  PolicyOnViolation,
  PolicySubjectKind,
  Snapshot,
  SnapshotBudgetAccount,
  SnapshotKey,
  SnapshotMeta,
  SnapshotPrice,
  SnapshotRoute,
  SnapshotTarget,
} from "@manifold/ports";
import type { Database } from "@manifold/database";
import { randomBytes } from "node:crypto";
import { computeContentHash } from "./canonical.js";
import * as q from "./db.js";
import type { PgSql, PriceRow } from "./db.js";
import type { ConfigOffering, ConfigPolicy, ConfigSnapshot } from "./types.js";

/**
 * Map a `provider_price_revision` row's per-mtok µ$ columns (decimal strings over the driver) into
 * the snapshot's `SnapshotPrice` (SPEC §6.10). A `null` column stays absent — "no price for that
 * token class", treated as µ$0 by `computeCost`. Only non-null classes are carried so the canonical
 * hash is stable regardless of how many optional columns a price revision populates.
 */
function priceFromRow(row: PriceRow): SnapshotPrice {
  const out: SnapshotPrice = {};
  const set = (k: keyof SnapshotPrice, v: string | null): void => {
    if (v !== null) out[k] = v;
  };
  set("inputPerMtokMicroUsd", row.input_per_mtok_microusd);
  set("outputPerMtokMicroUsd", row.output_per_mtok_microusd);
  set("cacheReadPerMtokMicroUsd", row.cache_read_per_mtok_microusd);
  set("cacheWritePerMtokMicroUsd", row.cache_write_per_mtok_microusd);
  set("reasoningPerMtokMicroUsd", row.reasoning_per_mtok_microusd);
  set("audioInPerMtokMicroUsd", row.audio_in_per_mtok_microusd);
  set("audioOutPerMtokMicroUsd", row.audio_out_per_mtok_microusd);
  return out;
}

/** Prefixed-ULID-ish id (§6.1 convention: prefixed text). Monotonic-ish for readability. */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(9).toString("hex")}`;
}

/**
 * Stamp a snapshot `meta` for a fresh (re)build: mint a new revision id + build time and clear
 * the derived `contentHash` + `signature` (recomputed / signed afterward). The stable identity
 * fields (schema, installationId, signingKeyId) are carried in via `carry`. Shared by the full
 * build (`assembleSnapshot`) and the key-only rebuild (`keyOnlyPublish`) so both mint identical
 * meta. Meta is EXCLUDED from `canonicalBody`, so this never affects the content hash or signature.
 */
export function stampMeta(
  carry: Pick<SnapshotMeta, "schema" | "installationId" | "signingKeyId">,
): SnapshotMeta {
  return {
    ...carry,
    revision: genId("cfgrev"),
    contentHash: "",
    builtAt: new Date().toISOString(),
    signature: "",
  };
}

/**
 * The OpenAI endpoint kinds config path-maps by name (SPEC §7.2/§7.4); any other `endpoint_kind`
 * string falls through to `/v1/<kind>`. Typed so a caller passing a known kind gets autocomplete
 * while the DB's free-text `endpoint_kind` column still assigns (the `string & {}` member).
 */
export type EndpointKind = "chat" | "responses" | "embeddings" | (string & {});

/** endpoint_kind → request pathname gateway-core resolves against (resolveRoute: `${profile}:${path}`). */
export function pathForKind(kind: EndpointKind): string {
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

export function hostFromUrl(url: string): string | null {
  try {
    // hostname (NOT host): ssrfCheck allowlist-matches URL.hostname, which never includes the
    // port. Using .host here (e.g. "proxy.example:8443") would self-block a ported target with
    // SSRF_BLOCKED even though it is the configured base_url (review bug #10).
    return new URL(url).hostname;
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
      // §6.6 policy-subject facets: enforce.ts stamps these onto the PolicySubject so a
      // `subject_kind='team'` / `'cost_center'` entitlement can match this key. Emitted verbatim
      // (null when unset — an absent facet never matches a scoped entitlement, deny-first).
      team: k.team_id,
      costCenter: k.cost_center_id,
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
  // TODO(perf, review N+1): this issues one readRouteRevision + one readTargets per route, then a
  // readCredential/readDek/readOffering/readPrice per target — sequential per-row round-trips.
  // Batch these (one IN-query per relation keyed by the collected ids) once the correctness fixes
  // below are settled. Deliberately NOT batched now so the per-target credential/allowlist filtering
  // stays obviously correct; batching is a pure read optimization with no behavior change.
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
      // readCredential filters revoked/invalid credentials (db.ts): a target that points at a
      // revoked or invalid provider credential returns null here and is DROPPED — a dead key never
      // ships in the snapshot (review bug: readCredential did not filter revoked_at/status).
      const cred = await q.readCredential(sql, t.provider_credential_id);
      if (!cred) continue;
      const dek = await q.readDek(sql, cred.dek_id);
      const offering = await q.readOffering(sql, t.offering_id);
      const baseUrl = t.base_url ?? cred.base_url ?? defaultBaseUrl(cred.provider);
      // Egress allowlist comes ONLY from the credential's configured allowed_hosts. We must NOT
      // auto-append the resolved baseUrl host: doing so lets a routes:write target aim a credential
      // whose allowed_hosts=["api.openai.com"] at an attacker host (baseUrl https://evil.example)
      // and have "evil.example" silently allowlisted, so ssrfCheck passes and the decrypted secret
      // is injected on the attacker's host (credential-exfil, review SECURITY bug). The allowlist is
      // exactly the credential's list; if the resolved baseUrl host is not in it, the target is a
      // config error — FAIL CLOSED by omitting it (never auto-grant egress, never ship a target
      // ssrfCheck could not guard).
      const allowedHosts = Array.isArray(cred.allowed_hosts)
        ? (cred.allowed_hosts as string[]).slice()
        : [];
      const host = hostFromUrl(baseUrl);
      if (!host || !allowedHosts.includes(host)) continue;
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
      // offerings section (budget eligibility + dispatch-time price, §7.1/§6.10)
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
          // The per-mtok µ$ prices the gateway stamps onto the terminal observation for cost.
          ...(price ? { price: priceFromRow(price) } : {}),
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
    // Snapshot route-map key (SPEC §7.2 / §7.4 line "`${profile}:${kind}:${name}`"): the
    // client-facing public_name (the `model` string) MUST be part of the key. Keying by only
    // `${profileId}:${pathForKind(kind)}` collides two same-kind routes (e.g. a chat route
    // gpt-4o→OpenAI and a chat route claude→Anthropic both map to
    // `${profile}:/v1/chat/completions`) so the last one written clobbers the other and one route
    // silently goes dead (review ROUTE-KEY CLOBBER bug). Including public_name keeps distinct
    // routes distinct. One entry per profile on this installation.
    //
    // KNOWN OPEN ITEM (review #222, route-key clobber): the SPEC §7.2 key shape is
    // `${profile}:${kind}:${public_name}`, which would let two same-kind routes coexist. We keep the
    // PATH-based key here so it matches gateway-core.resolveRoute (`${profileId}:${path}`) and
    // config-built snapshots actually route. Switching to the §7.2 key requires a coordinated
    // gateway-core resolveRoute redesign (map path→kind + read the request `model`), entangled with
    // the passthrough `/v1/messages` path that is not an OpenAI endpoint-kind. Deferred, not shipped
    // half-done: shipping the §7.2 key without the gateway side would break ALL config→gateway
    // routing (worse than the narrow multi-same-kind clobber). Tracked for a dedicated coordinated pass.
    for (const profileId of profileIds) {
      routes[`${profileId}:${pathForKind(route.endpoint_kind)}`] = snapRoute;
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
      // EVALUATOR shape (SPEC §6.6, §11) — the exact fields gateway-core/enforce.ts hands to
      // `@manifold/gateway-policy`.evaluate(). `snapshot.policies` is keyed by policy revision id
      // (`prid`), which is precisely what `SnapshotProfile.policyRevision` (= gateway_ingress_profile
      // .policy_revision_id) indexes in enforce.ts — so an operator's DB deny reaches the gateway.
      // A deny-first model_entitlement (effect 'deny' on canonical model M) denies M here.
      modelEntitlements: ents.map((e) => ({
        subjectKind: e.subject_kind as PolicySubjectKind,
        subjectRef: e.subject_ref,
        // Scope an `offering_id`-scoped entitlement to exactly that offering's canonical model.
        // The evaluator treats `canonicalModelId:null` as a MODEL WILDCARD (all models); emitting
        // null for an offering-scoped row would turn an offering-scoped allow into allow-ALL (a
        // privilege escalation) and a deny into deny-all. Resolve offering → canonical model
        // (readEntitlements JOIN); a row scoped by neither stays null (a genuine wildcard).
        canonicalModelId: e.canonical_model_id ?? e.offering_canonical_model_id,
        effect: e.effect,
      })),
      // NUMERIC bounds: `numeric` columns arrive from postgres-js as strings; the evaluator compares
      // `value > maxValue` numerically, so a string bound would coerce/compare wrong. Parse to number.
      requestConstraints: reqs.map((r) => ({
        param: r.param,
        maxValue: r.max_value === null ? null : Number(r.max_value),
        minValue: r.min_value === null ? null : Number(r.min_value),
        onViolation: r.on_violation as PolicyOnViolation,
      })),
      // TRANSPORT extras (§7.1): full entitlement projection (offering-aware, drives plan()'s
      // entitlement-removal tripwire), precomputed allow index, and data-handling constraints.
      entitlements: ents.map((e) => ({
        subjectKind: e.subject_kind,
        subjectRef: e.subject_ref,
        canonicalModelId: e.canonical_model_id,
        offeringId: e.offering_id,
        effect: e.effect,
      })),
      entitlementIndex,
      dataHandling: dh.map((d) => ({
        captureMode: d.capture_mode,
        redaction: d.redaction ?? null,
        allowedRegions: d.allowed_regions ?? null,
      })),
    };
  }

  // 5. budgets: budget_account id → SnapshotBudgetAccount (§16.3). Only the accounts referenced by
  //    a key ship — that is exactly what `SnapshotKey.budgetAccountId` indexes in enforce.ts, so a
  //    DB `hard` cap reaches the gateway's reserve gate (operator DB → emission → deny). DB
  //    enforcement 'hard' maps to snapshot 'hard' (reserves pre-dispatch); anything else ('advisory')
  //    maps to 'soft' (observe-only, never reserved). unit/window/limit ride along so the reservation
  //    adapter can derive the fixed-window bucket without a second read.
  const budgetAccountIds = [
    ...new Set(
      Object.values(keys)
        .map((k) => k.budgetAccountId)
        .filter((id): id is string => id != null),
    ),
  ];
  const budgets: Record<string, SnapshotBudgetAccount> = {};
  for (const b of await q.readBudgetAccounts(sql, budgetAccountIds)) {
    budgets[b.id] = {
      id: b.id,
      enforcement: b.enforcement === "hard" ? "hard" : "soft",
      unit: b.unit === "tokens" ? "tokens" : "cost_microusd",
      window: b.window as SnapshotBudgetAccount["window"],
      limit: b.limit_amount,
    };
  }

  const snapshot: ConfigSnapshot = {
    meta: stampMeta({ schema: "manifold.snapshot.v1", installationId, signingKeyId: "" }),
    profiles,
    keys,
    routes,
    offerings,
    policies,
    budgets,
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
