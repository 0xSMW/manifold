// @manifold/config — snapshot builder + publisher (SPEC §7.5, §8.2, §4.3).
//
// Public surface:
//   buildSnapshot(sql, installationId)        → §7 snapshot (unsigned; call signSnapshot)
//   signSnapshot / verifySnapshot             → ed25519 over the identity-bound message (§7.3, ADR-0024)
//   plan(sql, installationId, target)         → §8.2 plan (diff + tripwires)
//   apply(sql, plan, store, approvals?)       → §8.2 apply (one txn; records config_operation)
//   rollback(sql, revisionId, store)          → §8.2 rollback (republish prior bytes)
//   keyOnlyPublish(sql, workspaceId, installationId, store, opts?) → §8.2 H7 scoped key publish (→ null on no-op)
//   healthOnlyPublish(sql, workspaceId, installationId, store, opts) → durable health overlay publish
export {
  buildSnapshot,
  assembleSnapshot,
  buildKeysSection,
  pathForKind,
  authInjectFor,
  genId,
  hostFromUrl,
  type EndpointKind,
} from "./build.js";
export { plan } from "./plan.js";
export {
  apply,
  rollback,
  keyOnlyPublish,
  healthOnlyPublish,
  type KeyOnlyPublishOptions,
  type HealthOnlyPublishOptions,
} from "./apply.js";
export {
  signSnapshot,
  snapshotSigningMessage,
  verifySnapshot,
  generateSigningKeyPair,
  deriveSigningKeyId,
  normalizePrivateKey,
  normalizePublicKey,
  rawPublicKey,
  rawPrivateKey,
  type PrivateKeyInput,
  type PublicKeyInput,
  type VerifyResult,
} from "./signing.js";
export {
  computeContentHash,
  sha256Canonical,
  stableStringify,
  canonicalBody,
} from "./canonical.js";
export { InMemorySnapshotStore } from "./store.js";
export type {
  ConfigSnapshot,
  ConfigOffering,
  ConfigPolicy,
  ConfigEntitlement,
  SnapshotPublishStore,
  Plan,
  PlanDiff,
  TripwireItem,
  Approval,
  ConfigOperation,
} from "./types.js";
