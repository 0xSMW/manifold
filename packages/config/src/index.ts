// @manifold/config — snapshot builder + publisher (SPEC §7.5, §8.2, §4.3).
//
// Public surface:
//   buildSnapshot(db, installationId)        → §7 snapshot (unsigned; call signSnapshot)
//   signSnapshot / verifySnapshot            → ed25519 over contentHash (§7.3, ADR-0024)
//   planApply(db, installationId, target)    → §8.2 plan (diff + tripwires)
//   apply(db, plan, store)                   → §8.2 apply (one txn; records config_operation)
//   rollback(db, revisionId, store)          → §8.2 rollback (republish prior bytes)
//   keyOnlyPublish(db, installationId, store)→ §8.2 H7 scoped key publish
export { buildSnapshot, assembleSnapshot, buildKeysSection, pathForKind, authInjectFor, genId } from "./build.js";
export { planApply } from "./plan.js";
export { apply, rollback, keyOnlyPublish, type KeyOnlyPublishOptions } from "./apply.js";
export {
  signSnapshot,
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
  ConfigOperation,
} from "./types.js";
