// buildSnapshot(sql, installationId) — SPEC §7.5. Reads the active route revisions, keys,
// offerings, profiles, policies and credentials for an installation and emits the compact §7
// snapshot: profiles (host→profile), keys (hex(keyed_hash)→key), routes
// (`${profileId}:${endpointKind}:${publicName}`→targets with ciphertext + wrappedDek + authInject), offerings,
// policies. Canonicalizes and stamps `contentHash`. The result is a `ports.Snapshot` superset
// (§7.1 offerings/policies added), so gateway-core loads and routes it unchanged.
import type {
  AuthInject,
  EndpointKind,
  PolicyOnViolation,
  PolicySubjectKind,
  Snapshot,
  SnapshotBudgetAccount,
  SnapshotKey,
  SnapshotMeta,
  SnapshotPrice,
  SnapshotRateLimit,
  SnapshotRetryPolicy,
  SnapshotRoute,
  SnapshotTarget,
} from "@manifold/ports";
import { pathForEndpointKind } from "@manifold/ports";
import { prefixedUlid } from "@manifold/ids";
import { computeContentHash } from "./canonical.js";
import * as q from "./db.js";
import type { PgSql, PriceRow } from "./db.js";
import type { ConfigOffering, ConfigPolicy, ConfigSnapshot } from "./types.js";

type SnapshotCapturePolicy = { mode: "none" | "metadata" | "redacted" | "full"; maxBytes: number };

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

/**
 * Prefixed id (§6.1 convention: `<prefix>_<ULID>`). Delegates to the ONE id vocabulary
 * (`@manifold/ids`) so config/control-plane text PKs are real Crockford ULIDs — the same shape the
 * gateway and budget mint — instead of the old `prefix_<base36-time><hex>` fork. Kept as a thin
 * re-exported wrapper so every `genId("prefix")` call site (and control-plane's `lib/ids`) is
 * unchanged.
 */
export function genId(prefix: string): string {
  return prefixedUlid(prefix);
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

/** @deprecated Import `pathForEndpointKind` from @manifold/ports for new code. */
export const pathForKind = pathForEndpointKind;
export type { EndpointKind };

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

// Keep control-plane JSON from turning the signed hot snapshot into an
// unbounded transport. These caps are deliberately generous for route policy,
// while still putting a hard ceiling on what a Fluid isolate parses per reload.
const MAX_RATE_LIMIT = 1_000_000_000;
const MAX_RETRY_POLICY_KEYS = 32;
const MAX_RETRY_POLICY_ARRAY = 32;
const MAX_RETRY_POLICY_DEPTH = 4;
const MAX_RETRY_POLICY_STRING = 1_024;

function positiveRateLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_RATE_LIMIT
    ? value
    : undefined;
}

/**
 * Validate the compact virtual-key rate-limit shape at the snapshot boundary.
 * An invalid or empty JSON value is omitted instead of making a key unusable;
 * validation at the control-plane write edge remains the authoritative reject.
 */
export function snapshotRateLimit(value: unknown): SnapshotRateLimit | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const rateLimit: SnapshotRateLimit = {};
  const rpm = positiveRateLimit(input.rpm);
  const tpm = positiveRateLimit(input.tpm);
  const burst = positiveRateLimit(input.burst);
  if (rpm !== undefined) rateLimit.rpm = rpm;
  if (tpm !== undefined) rateLimit.tpm = tpm;
  if (burst !== undefined) rateLimit.burst = burst;
  return Object.keys(rateLimit).length === 0 ? undefined : rateLimit;
}

function boundedRetryValue(value: unknown, depth: number): unknown | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.length <= MAX_RETRY_POLICY_STRING ? value : undefined;
  if (depth >= MAX_RETRY_POLICY_DEPTH || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    if (value.length > MAX_RETRY_POLICY_ARRAY) return undefined;
    const out: unknown[] = [];
    for (const item of value) {
      const bounded = boundedRetryValue(item, depth + 1);
      if (bounded === undefined) return undefined;
      out.push(bounded);
    }
    return out;
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length > MAX_RETRY_POLICY_KEYS || keys.some((key) => key.length > MAX_RETRY_POLICY_STRING)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const bounded = boundedRetryValue(input[key], depth + 1);
    if (bounded === undefined) return undefined;
    out[key] = bounded;
  }
  return out;
}

/** Preserve valid revision JSON verbatim while bounding the signed transport. */
export function snapshotRetryPolicy(value: unknown): SnapshotRetryPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const bounded = boundedRetryValue(value, 0);
  return bounded && !Array.isArray(bounded) ? (bounded as SnapshotRetryPolicy) : undefined;
}

/**
 * The route API writes a target-id-bound replay contract only after checking
 * the selected offering adapter. Recheck while building the signed snapshot:
 * direct/legacy DB edits must degrade to the no-replay default, never grant a
 * billable POST retry.
 */
function retryPolicyWithVerifiedProviderIdempotency(
  policy: SnapshotRetryPolicy | undefined,
  targets: readonly SnapshotTarget[],
  targetCapabilities: ReadonlyMap<string, unknown>,
): SnapshotRetryPolicy | undefined {
  if (!policy) return undefined;
  const contract = policy.provider_idempotency;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return policy;
  const record = contract as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const targetId = record.target_id;
  const supported = typeof targetId === "string" &&
    keys.length === 2 && keys[0] === "header_name" && keys[1] === "target_id" &&
    record.header_name === "idempotency-key" &&
    targets.some((target) => target.targetId === targetId) &&
    providerIdempotencySupported(targetCapabilities.get(targetId));
  if (supported) return policy;
  const { provider_idempotency: _discarded, ...withoutContract } = policy;
  return withoutContract;
}

function providerIdempotencySupported(capabilities: unknown): boolean {
  return capabilities !== null && typeof capabilities === "object" && !Array.isArray(capabilities) &&
    (capabilities as Record<string, unknown>).providerIdempotency === "supported";
}

/** Fail closed for capture: absent/malformed revision policy means no payload tee. */
export function snapshotCapturePolicy(value: unknown): SnapshotCapturePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { mode: "none", maxBytes: 0 };
  const input = value as Record<string, unknown>;
  const mode = input.mode ?? input.captureMode ?? input.capture_mode;
  const rawBytes = input.maxBytes ?? input.max_bytes ?? input.byteCap ?? input.byte_cap;
  const maxBytes = typeof rawBytes === "number" && Number.isSafeInteger(rawBytes) && rawBytes > 0
    ? Math.min(rawBytes, 4_096)
    : 0;
  if ((mode !== "redacted" && mode !== "full") || maxBytes === 0) return { mode: "none", maxBytes: 0 };
  return { mode, maxBytes };
}

function snapshotHealthState(value: string): SnapshotTarget["healthState"] {
  return value === "healthy" || value === "degraded" || value === "unhealthy" || value === "unknown"
    ? value
    : "unknown";
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
    const rateLimit = snapshotRateLimit(k.rate_limit);
    keys[hex] = {
      id: k.id,
      profileId: k.profile_id,
      scopes: scopesToArray(k.scopes),
      allowedAppIds: Array.isArray(k.allowed_app_ids) ? (k.allowed_app_ids as string[]) : [],
      budgetAccountId: k.budget_account_id,
      expiresAt: toIso(k.expires_at),
      ...(rateLimit ? { rateLimit } : {}),
      // Revoked keys are filtered OUT at read time (readVirtualKeys: `revoked_at IS NULL`, F10), so
      // every key that reaches here is live — there is no `revoked` flag to carry. A revoked key is
      // simply absent from this map and authenticates as AUTH_KEY_UNKNOWN.
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
    const targetCapabilities = new Map<string, unknown>();
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
        targetId: t.id,
        offeringId: t.offering_id,
        credentialId: cred.id,
        dekId: cred.dek_id,
        kekId: dek?.kek_id,
        credentialCiphertext: Buffer.from(cred.encrypted_secret).toString("base64"),
        wrappedDek: dek ? Buffer.from(dek.wrapped_dek).toString("base64") : "",
        weight: t.weight,
        priority: t.priority,
        healthState: snapshotHealthState(t.health_state),
        baseUrl,
        region: t.region ?? offering?.region ?? null,
        allowedHosts,
        authInject: authInjectFor(cred.provider),
      });
      targetCapabilities.set(t.id, offering?.capabilities);
      // offerings section (budget eligibility + dispatch-time price, §7.1/§6.10)
      if (offering && !offerings[offering.id]) {
        const price = await q.readEffectivePrice(
          sql,
          offering.id,
          workspaceId,
          offering.active_price_revision_id,
        );
        offerings[offering.id] = {
          provider: offering.provider,
          providerModelId: offering.provider_model_id,
          adapterRevision: offering.adapter_revision,
          region: offering.region,
          priceRevisionId: price?.id ?? null,
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

    const retryPolicy = retryPolicyWithVerifiedProviderIdempotency(
      snapshotRetryPolicy(rev.retry_policy),
      targets,
      targetCapabilities,
    );
    const snapRoute: SnapshotRoute & { capturePolicy: SnapshotCapturePolicy } = {
      routeId: route.id,
      revision: rev.id,
      mode: rev.mode,
      targets,
      ...(retryPolicy ? { retryPolicy } : {}),
      timeoutMs,
      capturePolicyId: `cap:${route.id}`,
      capturePolicy: snapshotCapturePolicy(rev.capture_policy),
    };
    // Snapshot route-map key (SPEC §7.2 / §7.4 line "`${profile}:${kind}:${name}`"): the
    // client-facing public_name (the `model` string) MUST be part of the key. Keying by only
    // `${profileId}:${pathForKind(kind)}` collides two same-kind routes (e.g. a chat route
    // gpt-4o→OpenAI and a chat route claude→Anthropic both map to
    // `${profile}:/v1/chat/completions`) so the last one written clobbers the other and one route
    // silently goes dead (review ROUTE-KEY CLOBBER bug). Including public_name keeps distinct
    // routes distinct. One entry per profile on this installation.
    //
    for (const profileId of profileIds) {
      routes[`${profileId}:${route.endpoint_kind}:${route.public_name}`] = snapRoute;
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
  //    DB `hard` cap reaches the gateway's reserve gate (operator DB → emission → deny). The DB
  //    `budget_enforcement_chk` CHECK is ('advisory','hard'), the same vocabulary the snapshot uses,
  //    so `enforcement` passes through verbatim: 'hard' reserves pre-dispatch, 'advisory' is
  //    observe-only (never reserved). unit/window/limit ride along so the reservation adapter can
  //    derive the fixed-window bucket without a second read.
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
      enforcement: b.enforcement === "hard" ? "hard" : "advisory",
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
  sql: PgSql,
  installationId: string,
): Promise<ConfigSnapshot> {
  const inst = await q.readInstallation(sql, installationId);
  if (!inst) throw new Error(`installation not found: ${installationId}`);
  return assembleSnapshot(sql, installationId, inst.workspace_id);
}
