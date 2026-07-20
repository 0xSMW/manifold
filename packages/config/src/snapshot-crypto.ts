// @manifold/config/signing — the DB-FREE snapshot-crypto surface (SPEC §7.3, ADR-0007/0024).
//
// This is the single owner of snapshot canonicalization + content hashing + ed25519 sign/verify.
// It re-exports ONLY canonical.ts + signing.ts, whose transitive imports are node:crypto,
// @manifold/domain, and TYPE-ONLY @manifold/ports/@manifold/contracts — it NEVER pulls the
// DB-tainted config barrel (build/apply/db → @manifold/database). The gateway loader imports this
// subpath to verify snapshots on load without dragging a postgres driver into its runtime; the
// control plane / config package reach the same functions through the main barrel. There is exactly
// ONE implementation of the canonical body / signing message — no fork to keep byte-for-byte in sync.
export { canonicalBody, computeContentHash, sha256Canonical, stableStringify } from "./canonical.js";
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
