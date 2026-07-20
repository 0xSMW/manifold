// @manifold/config types — the snapshot the builder emits and the plan/operation shapes
// the publishing lifecycle produces (SPEC §7, §8.2).
//
// The hot-path snapshot the gateway actually loads is `@manifold/ports`'s `Snapshot`
// (profiles/keys/routes) — gateway-core reads exactly those three maps (§7.2, resolveRoute /
// authenticate / resolveProfile). SPEC §7.1/§7.2 also carries `offerings` and `policies`
// sections for budget-eligibility and static policy. gateway-core ignores unknown top-level
// keys, so we emit a superset: a `ConfigSnapshot` that *is* a `ports.Snapshot` plus the two
// extra sections. This keeps the built blob loadable + signature-verifiable by gateway-core
// while still carrying everything §7 asks for.
import type { ReasonCode } from "@manifold/contracts";
import type { Snapshot, SnapshotPolicyRevision } from "@manifold/ports";

/** SPEC §7.1 `offerings`: offering id → provider/codec/price metadata for budget eligibility. */
export interface ConfigOffering {
  provider: string;
  providerModelId: string;
  adapterRevision: string;
  region: string | null;
  priceRevisionId: string | null;
  /** provider_verified | operator_override | aggregator | unknown (§6.4, ADR-0009). */
  priceFidelity: string | null;
  capabilities: unknown;
  baseUrl: string | null;
}

/** A single entitlement row projected into the snapshot policy section (§6.6). */
export interface ConfigEntitlement {
  subjectKind: string;
  subjectRef: string | null;
  canonicalModelId: string | null;
  offeringId: string | null;
  effect: "allow" | "deny";
}

/**
 * SPEC §7.1 `policy`: policy revision id → entitlements + request/data constraints.
 *
 * ConfigPolicy is a STRUCTURAL SUPERSET of ports' `SnapshotPolicyRevision`: it carries the exact
 * EVALUATOR shape the gateway reads (`modelEntitlements` + NUMERIC-bound `requestConstraints`, keyed
 * by policy revision id under `snapshot.policies`, indexed by `SnapshotProfile.policyRevision`) so a
 * config-built snapshot drives gateway policy enforcement end-to-end (operator DB deny → emission →
 * enforce.ts → 403). On top of the evaluator fields it keeps the §7.1 TRANSPORT extras
 * (`entitlements` projection, precomputed `entitlementIndex`, `dataHandling`) as optional additions.
 */
export interface ConfigPolicy extends SnapshotPolicyRevision {
  /** Full entitlement projection incl. `offeringId` (§6.6). Drives plan()'s entitlement-removal
   *  tripwire; the evaluator uses only `modelEntitlements` (from the base interface). */
  entitlements?: ConfigEntitlement[];
  /** subject → allowed model/offering refs, precomputed index (§7.1 "entitlements index"). */
  entitlementIndex?: Record<string, string[]>;
  dataHandling?: Array<{
    captureMode: string;
    redaction: unknown;
    allowedRegions: unknown;
  }>;
}

/**
 * The full built snapshot. Structurally a `ports.Snapshot` (so gateway-core loads it), with
 * the two additional §7 sections. Everything under here is canonicalized + hashed except
 * `meta.signature` (§7.3).
 */
// INTEGRATION SEAM (closed): config now emits `policies` in the EVALUATOR shape the gateway reads.
// `ConfigPolicy` extends ports' `SnapshotPolicyRevision`, so `Record<string, ConfigPolicy>` IS a
// valid `Snapshot["policies"]` — `ConfigSnapshot extends Snapshot` directly (no `Omit`, no
// `as unknown as Snapshot`). A snapshot built by `assembleSnapshot` carries the operator's DB
// entitlements/constraints straight into `enforce.ts` → `evaluate()` (end-to-end, proven by
// config/test/policy-e2e-pg.test.ts). The extra §7.1 transport fields ride along as optional adds.
export interface ConfigSnapshot extends Snapshot {
  offerings: Record<string, ConfigOffering>;
  policies: Record<string, ConfigPolicy>;
}

/**
 * SnapshotStore, publish side (SPEC §4.4). `@manifold/ports` currently exports only the
 * `loadActive` half of §4.4's `SnapshotStore`; the publish/pointer half lives here so the
 * config package can drive `apply`/`rollback` without editing ports. Adapters (Edge Config /
 * KV) implement the full surface.
 */
export interface SnapshotPublishStore {
  /** Publish a built snapshot; returns the platform version handle (§4.4, §8.2). */
  publish(
    installationId: string,
    revision: string,
    snap: Snapshot,
  ): Promise<{ version: string }>;
  /** The currently-published pointer for an installation. */
  pointer(installationId: string): Promise<{ revision: string; version: string } | null>;
  /** Load the active snapshot (the read half, mirrors ports.SnapshotStore). */
  loadActive(installationId: string): Promise<Snapshot>;
}

/** A destructive change requiring approval before apply (SPEC §8.2 tripwire). */
export interface TripwireItem {
  kind: "route_delete" | "entitlement_removal";
  ref: string;
  detail: Record<string, unknown>;
}

/** SPEC §8.2 `plan()` output. Carries the target snapshot so `apply` needs no rebuild. */
export interface Plan {
  installationId: string;
  workspaceId: string;
  /** content hash of the current active revision, or null when none is active. */
  baseConfigHash: string | null;
  targetConfigHash: string;
  planHash: string;
  diffJson: PlanDiff;
  tripwireItems: TripwireItem[];
  /** The signed target snapshot (§8.2: apply consumes the plan, no rebuild). */
  snapshot: ConfigSnapshot;
  /** True when target content == active content: apply is a no-op (§8.2 idempotency). */
  noop: boolean;
}

export interface PlanDiff {
  routes: { added: string[]; removed: string[]; changed: string[] };
  keys: { added: string[]; removed: string[]; changed: string[] };
  offerings: { added: string[]; removed: string[]; changed: string[] };
  policies: { added: string[]; removed: string[]; changed: string[] };
}

/** A projected `config_operation` row (SPEC §6.11). */
export interface ConfigOperation {
  id: string;
  installationId: string;
  workspaceId: string;
  baseConfigHash: string | null;
  targetConfigHash: string | null;
  planHash: string | null;
  outcome: "written" | "accepted" | "rejected" | "failed";
  edgeConfigVersion: string | null;
  tripwireItems: TripwireItem[];
  /** The new active revision id when the operation produced one. */
  revisionId: string | null;
  /** SPEC §0.2 reason code (contracts `ReasonCode`), e.g. CONFIG_PRECONDITION_FAILED. */
  reasonCode: ReasonCode | null;
}
