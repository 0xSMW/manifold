// apps/gateway — snapshot signature verification POLICY on load (SPEC §7.3, ADR-0024).
//
// The crypto itself (canonical body, content hashing, ed25519 verify) is owned ONCE by
// @manifold/config and imported here through its DB-FREE subpath export `@manifold/config/signing`
// (canonical.ts + signing.ts only — node:crypto + @manifold/domain + type-only ports; it does NOT
// pull @manifold/database into the gateway runtime). There is no longer a byte-for-byte fork to keep
// in sync: a config-signed snapshot verifies here because it is literally the same code.
//
// This module keeps only what is gateway-specific: WHICH env pins the key, WHEN a missing key must
// fail closed, and the dev-only warn-and-load escape hatch.
import type { Snapshot } from "@manifold/ports";
import { verifySnapshot, type VerifyResult } from "@manifold/config/signing";

// Re-export the shared verifier so existing gateway callers/tests keep importing it from here.
export { verifySnapshot };
export type SnapshotVerifyResult = VerifyResult;

/** Truthy MANIFOLD_REQUIRE_SIGNED flag — forces signature verification even outside production. */
function requireSignedFlag(): boolean {
  const v = (process.env.MANIFOLD_REQUIRE_SIGNED ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Enforce §7.3 on load. When a public key is pinned (env `MANIFOLD_SNAPSHOT_PUBLIC_KEY`, base64),
 * verify and THROW (fail closed) on any mismatch.
 *
 * When NO key is pinned the policy depends on the environment: in production (NODE_ENV==='production')
 * or when MANIFOLD_REQUIRE_SIGNED is set, loading an UNVERIFIED snapshot is fail-OPEN, so we THROW
 * (fail closed). ONLY outside production (dev) do we fall back to the warn-and-load escape hatch that
 * keeps snapshot.example.json booting locally.
 */
export function assertSnapshotTrusted(snapshot: Snapshot, publicKeyBase64?: string): void {
  const pinned = publicKeyBase64 ?? process.env.MANIFOLD_SNAPSHOT_PUBLIC_KEY;
  if (!pinned) {
    if (process.env.NODE_ENV === "production" || requireSignedFlag()) {
      throw new Error(
        "MANIFOLD_SNAPSHOT_PUBLIC_KEY is not set but snapshot verification is REQUIRED " +
          "(NODE_ENV=production or MANIFOLD_REQUIRE_SIGNED) — refusing to load an unverified snapshot " +
          "(§7.3, fail closed). Pin the base64 ed25519 public key.",
      );
    }
    console.warn(
      "[manifold] WARNING: MANIFOLD_SNAPSHOT_PUBLIC_KEY is not set — loading an UNVERIFIED snapshot. " +
        "The snapshot signature is NOT checked; a forged snapshot would be trusted. " +
        "Set MANIFOLD_SNAPSHOT_PUBLIC_KEY (base64 ed25519 public key) in any non-dev environment (§7.3).",
    );
    return;
  }
  const result = verifySnapshot(snapshot, pinned);
  if (!result.ok) {
    throw new Error(`snapshot signature verification failed: ${result.reason} (§7.3, fail closed)`);
  }
}
