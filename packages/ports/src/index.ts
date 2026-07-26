// @manifold/ports — platform-adapter INTERFACES only. Pure types, ZERO platform imports.
// SPEC §4.4 (port interfaces), §7.2 (snapshot schema). Adapters (apps/gateway, adapters-*)
// implement these; gateway-core depends only on the interfaces, never on an adapter (§4.2).
import type {
  PolicyEffect,
  PolicyOnViolation,
  PolicySubjectKind,
  ReasonCode,
} from "@manifold/contracts";

// ────────────────────────────────────────────────────────────────────────────
// Snapshot schema (SPEC §7.2). The hot-path blob the gateway reads to route,
// authenticate, and apply static policy with zero DB reads (ADR-0005). Modeled
// here as pure TS types; the control plane's `config.buildSnapshot` (§7.5) emits
// this shape and signs it. Contracts will host the zod version; ports carries the
// structural types the runtime seam needs.
// ────────────────────────────────────────────────────────────────────────────

export interface SnapshotMeta {
  /** SPEC §7.2: pinned snapshot schema id. */
  schema: "manifold.snapshot.v1";
  installationId: string;
  revision: string;
  /** sha256:… over canonical body excluding meta.signature (§7.3). */
  contentHash: string;
  builtAt: string;
  /** base64 ed25519 over contentHash (§7.3). Verified against pinned public key on load. */
  signature: string;
  signingKeyId: string;
}

export interface SnapshotProfile {
  /** Stable profile id, referenced by SnapshotKey.profileId. Independent of the host string. */
  id: string;
  /** ADR-0001: the two disjoint trust models. */
  mode: "public_app" | "enterprise_egress";
  /** Bound policy revision id for this profile. */
  policyRevision: string | null;
  /** Default route-set id (§7.1). */
  defaultRouteSet: string | null;
}

export interface SnapshotKey {
  id: string;
  /** ADR-0001: a key belongs to exactly one profile; cross-profile use fails AUTH_PROFILE_MISMATCH. */
  profileId: string;
  scopes: string[];
  allowedAppIds: string[];
  budgetAccountId: string | null;
  /** ISO timestamp; null = never expires. */
  expiresAt: string | null;
  /**
   * Optional per-key admission limits. Every present value is a positive
   * integer; omitted limits retain the platform default. This remains optional
   * so signed snapshots published before rate limiting stay readable.
   */
  rateLimit?: SnapshotRateLimit;
  // NOTE: there is no `revoked` flag. Revoked keys are filtered out at build (config/db.ts
  // `readVirtualKeys` selects only `revoked_at IS NULL`, F10), so a revoked key never ships in the
  // signed snapshot — it is absent from `snapshot.keys` and authenticates as AUTH_KEY_UNKNOWN.
  /** Optional policy-subject facets (SPEC §6.6 `subject_kind`). Absent facets never match a
   *  scoped entitlement (deny-first). `keyScope`/`app` are derived from scopes/allowedAppIds. */
  team?: string | null;
  costCenter?: string | null;
}

/** Bounded key-level rate-limit configuration carried by the signed snapshot. */
export interface SnapshotRateLimit {
  rpm?: number;
  tpm?: number;
  burst?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Static policy carried in the snapshot (SPEC §6.6, §11 Policies). These mirror
// @manifold/gateway-policy's `PolicyRevision` shape STRUCTURALLY — ports imports no
// evaluator, so the snapshot stays self-describing and the SAME object the gateway
// reads here is passed straight to `policy.evaluate()` in the core (SPEC §21.5 parity).
// ────────────────────────────────────────────────────────────────────────────

// SPEC §6.6 policy vocabulary — owned by @manifold/contracts (the leaf), re-exported
// here so the snapshot types stay in lockstep with the evaluator and DB CHECKs.
export type { PolicySubjectKind, PolicyOnViolation };
/** SPEC §6.6 `effect`. Alias of @manifold/contracts' `PolicyEffect`. */
export type PolicyEntitlementEffect = PolicyEffect;

export interface SnapshotModelEntitlement {
  subjectKind: PolicySubjectKind;
  subjectRef: string | null;
  canonicalModelId: string | null;
  effect: PolicyEntitlementEffect;
}

export interface SnapshotRequestConstraint {
  param: string;
  maxValue: number | null;
  minValue: number | null;
  onViolation: PolicyOnViolation;
}

/** The immutable policy revision the evaluator reads (SPEC §11). Indexed by SnapshotProfile.policyRevision. */
export interface SnapshotPolicyRevision {
  modelEntitlements: SnapshotModelEntitlement[];
  requestConstraints: SnapshotRequestConstraint[];
}

/**
 * A budget account's enforcement class (SPEC §16.3). Mirrors the DB `budget_enforcement_chk`
 * CHECK (`'advisory' | 'hard'`) verbatim — no synonym translation across the seam. Only `hard`
 * reserves pre-dispatch.
 */
export type BudgetEnforcement = "advisory" | "hard";

/** A budget account's enforcement class (SPEC §16.3). Only `hard` reserves pre-dispatch. */
export interface SnapshotBudgetAccount {
  id: string;
  /** `hard` ⇒ strong-consistency reserve before dispatch (§16.3); `advisory` ⇒ observe-only. */
  enforcement: BudgetEnforcement;
  /**
   * §7 self-describing budget metadata, emitted by config so the gateway's reservation adapter can
   * derive the fixed-window bucket without a second lookup (enforce.ts itself reads only
   * `enforcement`; these are additive). `unit` selects µ$ vs token counters; `window` drives
   * `bucketStart`; `limit` is the cap as a decimal string (µ$ or tokens, per `unit`).
   */
  unit?: "cost_microusd" | "tokens";
  window?: "daily" | "weekly" | "monthly" | "rolling_30d" | "total";
  limit?: string;
}

/**
 * Provider auth injection template (SPEC §2.8/§14.4: "provider auth is injected fresh").
 * Header values may contain the literal `${secret}` placeholder, substituted at dispatch
 * time with the decrypted provider secret. Works across providers:
 *   Anthropic → { "x-api-key": "${secret}", "anthropic-version": "2023-06-01" }
 *   OpenAI    → { "authorization": "Bearer ${secret}" }
 */
export interface AuthInject {
  headers: Record<string, string>;
}

export interface SnapshotTarget {
  /**
   * Stable identity of the persisted gateway_target row. Optional so signed
   * snapshots created before target identities were introduced remain valid.
   */
  targetId?: string;
  offeringId: string;
  credentialId: string;
  dekId: string;
  /** KEK identity used to wrap this DEK. Omitted by snapshots created before KEK versioning. */
  kekId?: string;
  /** base64 AES-256-GCM {iv|ct|tag} of the provider secret (ADR-0022). Never plaintext. */
  credentialCiphertext: string;
  /** base64 KEK-wrapped DEK; unwrapped once per isolate, KEK never in snapshot (A2). */
  wrappedDek: string;
  weight: number;
  priority: number;
  /**
   * Last control-plane health assessment. Older snapshots omit this field and
   * are treated by consumers as `unknown`.
   */
  healthState?: "healthy" | "degraded" | "unhealthy" | "unknown";
  /** Provider base URL, e.g. https://api.anthropic.com. */
  baseUrl: string;
  region: string | null;
  /** SSRF egress allowlist for this target (§2.8/§14.4, `provider_credential.allowed_hosts`). */
  allowedHosts: string[];
  /** How to inject provider auth freshly on the upstream request (§2.8). */
  authInject: AuthInject;
}

export interface SnapshotRoute {
  routeId: string;
  revision: string;
  mode: "ordered" | "weighted";
  targets: SnapshotTarget[];
  /**
   * The route revision's policy JSON, carried without key translation. The
   * builder bounds its JSON shape before signing so a configuration row cannot
   * inflate a Fluid isolate's hot snapshot.
   */
  retryPolicy?: SnapshotRetryPolicy;
  /** Milliseconds; overall upstream timeout (§14.4). */
  timeoutMs: number;
  capturePolicyId: string;
  /** Explicit, signed capture bound. Omitted by legacy snapshots and therefore fail-closed. */
  capturePolicy?: SnapshotCapturePolicy;
}

export interface SnapshotCapturePolicy {
  mode: "none" | "metadata" | "redacted" | "full";
  /** Absolute cap for the combined request/response capture envelope. */
  maxBytes: number;
}

/** JSON-compatible, bounded route retry-policy payload. */
export type SnapshotRetryPolicy = Record<string, unknown>;

/**
 * Client endpoint vocabulary shared by snapshot construction and lookup. The
 * open string member preserves support for configured provider-specific kinds.
 */
export type EndpointKind = "chat" | "responses" | "embeddings" | (string & {});

/** The public request pathname associated with an endpoint kind. */
export function pathForEndpointKind(kind: EndpointKind): string {
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

/**
 * Per-mtok µ$ prices resolved at dispatch (SPEC §6.10, §6.4 `provider_price_revision`). Each
 * field is a DECIMAL STRING of integer µ$ per 1,000,000 tokens — a string (not a bigint) so the
 * whole snapshot stays plain JSON/signature-verifiable while remaining bigint-exact once parsed
 * (mirrors `SnapshotBudgetAccount.limit`, which is likewise a decimal string). A `null`/absent
 * field means "no price for that token class" (treated as µ$0 by `computeCost`).
 */
export interface SnapshotPrice {
  inputPerMtokMicroUsd?: string | null;
  outputPerMtokMicroUsd?: string | null;
  cacheReadPerMtokMicroUsd?: string | null;
  cacheWritePerMtokMicroUsd?: string | null;
  reasoningPerMtokMicroUsd?: string | null;
  audioInPerMtokMicroUsd?: string | null;
  audioOutPerMtokMicroUsd?: string | null;
}

/**
 * §7.1 `offerings`: the price the gateway resolves AT DISPATCH and stamps onto the terminal
 * observation (so cost is computed from the price in force when the request ran, not whatever is
 * current at projection time). Keyed by `SnapshotTarget.offeringId` under `Snapshot.offerings`.
 * `config.buildSnapshot` emits a structural superset (`ConfigOffering`); gateway-core reads only
 * these two fields.
 */
export interface SnapshotOffering {
  /** Provider-native model identifier substituted into the outbound OpenAI-compatible body. */
  providerModelId?: string;
  priceRevisionId?: string | null;
  price?: SnapshotPrice;
}

export interface Snapshot {
  meta: SnapshotMeta;
  /** host → profile (§7.2). Resolved pre-auth from the trusted host (ADR-0001). */
  profiles: Record<string, SnapshotProfile>;
  /** hex(HMAC(pepper, presentedKey)) → key (§7.2). O(1) lookup, no scan. */
  keys: Record<string, SnapshotKey>;
  /**
   * `${profileId}:${endpointKind}:${publicName}` → route (§7.2). During the
   * snapshot migration, readers also accept legacy `${profileId}:${path}` keys.
   */
  routes: Record<string, SnapshotRoute>;
  /**
   * Bound policy revisions by id (§7.2). `SnapshotProfile.policyRevision` indexes this.
   * Absent / unmatched ⇒ the profile carries no static policy and enforcement is a no-op.
   */
  policies?: Record<string, SnapshotPolicyRevision>;
  /**
   * Budget accounts by id (§16.3). `SnapshotKey.budgetAccountId` indexes this. A key whose
   * account is absent or `advisory` is not reserved pre-dispatch; a `hard` account is (deny-first).
   */
  budgets?: Record<string, SnapshotBudgetAccount>;
  /**
   * Offerings by id (§7.1). `SnapshotTarget.offeringId` indexes this. Carries the dispatch-time
   * price the gateway stamps onto the terminal observation for cost (§6.10). Absent ⇒ the gateway
   * emits the terminal with no price and the projected cost is µ$0 (unknown fidelity).
   */
  offerings?: Record<string, SnapshotOffering>;
}

// ────────────────────────────────────────────────────────────────────────────
// Observation events (SPEC §8.3 / ADR-0011). The gateway is a producer; the sink
// is write-only. Minimal shape the passthrough path needs.
// ────────────────────────────────────────────────────────────────────────────

export type ObservationEventKind = "accepted" | "provider_attempt" | "terminal";

/**
 * Provider-reported token usage on a terminal event (SPEC §8.3). Plain `number`s (token counts
 * are small integers, exactly representable) so the flat event stays JSON-serializable through the
 * ingest transport; the observability mapper widens them to `bigint` for the §6.10 cost math.
 */
export interface ObservationUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  cacheWriteTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
}

/**
 * A gateway-produced, byte-bounded request/response envelope. It deliberately
 * excludes headers and credentials; it is only emitted when the signed route
 * capture policy permits it.
 */
export interface ObservationCapture {
  /** Effective signed gateway policy mode at capture time. */
  mode: "redacted" | "full";
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  truncated?: boolean;
  bytes: number;
}

/**
 * The FLAT hot-path observation event the gateway emits (SPEC §8.3 / ADR-0011). One row per emit,
 * no tenancy / dedup anchor, token counts as plain numbers, prices as decimal strings — everything
 * the passthrough core produces without importing @manifold/domain. `@manifold/observability`'s
 * `journalFromPortsEvent` (the single bridge) widens this into `JournalObservationEvent`.
 */
export interface HotPathObservationEvent {
  /** Idempotency anchor for the trace (§8.1). */
  traceId: string;
  kind: ObservationEventKind;
  /** Monotonic per-producer sequence within a trace (ADR-0011). */
  seq: number;
  occurredAt: string;
  profileId: string;
  keyId: string | null;
  routeId: string | null;
  offeringId: string | null;
  /** HTTP status observed upstream / returned to client, if known. */
  status: number | null;
  /** Reason codes attached to this event (§0.2). */
  reasonCodes: ReasonCode[];
  /**
   * Immutable target identity for a provider attempt. These stay optional on
   * the flat union so pre-existing accepted/terminal producers remain
   * compatible; the observation ingest boundary requires all four attribution
   * fields when `kind === "provider_attempt"`.
   */
  targetId?: string;
  /** Immutable route revision selected for a provider attempt. */
  routeRevisionId?: string;
  /** Signed snapshot revision that authorized a provider attempt. */
  snapshotRevision?: string;
  /** Normalized provider-attempt result for target-health aggregation. */
  attemptOutcome?: "success" | "transient_failure" | "permanent_failure";
  // ── Terminal-only billing fields (SPEC §8.3, §6.9/§6.10). All optional so non-terminal events
  //    and the pre-usage-capture path (streamed responses) omit them and reduce to µ$0. ──────────
  /** Provider-reported token counts, parsed from the response `usage` block. */
  usage?: ObservationUsage;
  /** Dispatch-time per-mtok price (from `snapshot.offerings[offeringId]`) — the §6.10 cost input. */
  price?: SnapshotPrice;
  /** The `provider_price_revision` id the `price` came from (cost_ledger provenance, §6.9). */
  priceRevisionId?: string | null;
  /** Budget account this trace billed against (cost_ledger dim + reconcile target, §6.9/§8.4). */
  budgetAccountId?: string | null;
  /** The hard-budget reservation to reconcile reserved→committed with the actual cost (§8.4). */
  reservationId?: string | null;
  /**
   * Explicitly marks a conservative gateway-side fallback estimate. Provider-reported usage omits
   * this field and the ingest mapper derives its normal exact/unknown fidelity from usage + price.
   */
  costFidelity?: "estimated";
  /** Terminal-only bounded capture from the gateway tee. */
  capture?: ObservationCapture;
}

// ────────────────────────────────────────────────────────────────────────────
// Platform adapter interfaces (SPEC §4.4). The runtime seam.
// ────────────────────────────────────────────────────────────────────────────

export interface SnapshotStore {
  /** Load the active snapshot for an installation. Zero-DB-read hot path (ADR-0005). */
  loadActive(installationId: string): Promise<Snapshot>;
}

export interface IngestSink {
  /** Emit an observation event (after()+ledger on Vercel | Queue on Cloudflare). */
  emit(event: HotPathObservationEvent): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Crypto {
  /**
   * Keyed hash for virtual keys/tokens (§14.3). Async per review M10: some runtimes
   * (WebCrypto/Workers) only expose async HMAC, so the port is async everywhere.
   */
  hmacSha256(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array>;
  /** Generate a prefixed random id (e.g. trace id). */
  randomId(prefix: string): string;
  /** Seal plaintext under a DEK (AES-256-GCM), producing {iv|ct|tag} (§14.3). */
  sealAesGcm(dek: Uint8Array, pt: Uint8Array): Uint8Array;
  /** Open ciphertext {iv|ct|tag} under a DEK (AES-256-GCM) in-proc (ADR-0022, §14.3). */
  openAesGcm(dek: Uint8Array, ct: Uint8Array): Uint8Array;
}

export interface Fetcher {
  /** Provider egress. Implementations wrap SSRF policy (§14.4). */
  fetch(req: Request): Promise<Response>;
}

/**
 * Hard-budget reservation seam (SPEC §16.3, ADR-0012). The gateway core NEVER imports
 * @manifold/budget or any DB driver (§4.2/§4.4); it calls this port, whose adapter runs the
 * one strong-consistency reserve transaction. `reserve` is the single pre-dispatch guard:
 * `committed + reserved + est ≤ limit`. A denial means "over cap" — the request MUST NOT be
 * dispatched to the provider.
 */
export interface BudgetReserveInput {
  budgetAccountId: string;
  /** Gateway trace-id; the idempotency anchor for the reservation (§8.4). */
  requestId: string;
  /** Pre-dispatch cost estimate in µ$ (§6.10). */
  estMicroUsd: bigint;
  /** Pre-dispatch token estimate so a `unit=tokens` hard budget can guard on reserved_tokens
   *  BEFORE dispatch (§16.3); absent ⇒ the token guard sees 0 (µ$ budgets ignore these). */
  estimatedInputTokens?: bigint;
  maxOutputTokens?: bigint;
}

export type BudgetReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: "BUDGET_RESERVE_DENIED" };

export interface BudgetReserver {
  reserve(input: BudgetReserveInput): Promise<BudgetReserveResult>;
}
