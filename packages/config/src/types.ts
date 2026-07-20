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
import type { Snapshot } from "@manifold/ports";

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

/** SPEC §7.1 `policy`: policy revision id → entitlements + request/data constraints. */
export interface ConfigPolicy {
  entitlements: ConfigEntitlement[];
  /** subject → allowed model/offering refs, precomputed index (§7.1 "entitlements index"). */
  entitlementIndex: Record<string, string[]>;
  requestConstraints: Array<{
    param: string;
    maxValue: string | null;
    minValue: string | null;
    onViolation: string;
  }>;
  dataHandling: Array<{
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
  reasonCode: string | null;
}
