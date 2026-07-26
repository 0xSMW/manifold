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
import { normalizePublicKey, verifySnapshot, type VerifyResult } from "@manifold/config/signing";

// Re-export the shared verifier so existing gateway callers/tests keep importing it from here.
export { verifySnapshot };
export type SnapshotVerifyResult = VerifyResult;

/** A bounded set of active snapshot signing keys, indexed by `meta.signingKeyId`. */
export type SnapshotPublicKeyring = Readonly<Record<string, string>>;

export interface SnapshotTrust {
  /** Legacy single pin. It remains supported for existing deployments. */
  publicKeyBase64?: string;
  /** Rotation-safe pins. When present, only `meta.signingKeyId` selects a key. */
  publicKeys?: SnapshotPublicKeyring;
}

const MAX_KEYRING_KEYS = 4;
const MAX_KEY_ID_LENGTH = 256;
const MAX_PUBLIC_KEY_BASE64_LENGTH = 4_096;
const KEY_ID_RE = /^[A-Za-z0-9_-]+$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidKeyring(): never {
  // Deliberately do not include key material or the raw environment value.
  throw new Error("MANIFOLD_SNAPSHOT_PUBLIC_KEYS must be a non-empty JSON object of at most 4 Ed25519 public keys");
}

/**
 * Strictly parse and validate the rotation keyring environment value. Validation is eager so a
 * malformed deployment never reaches a request path, and checks the actual Ed25519 key encoding
 * without retaining or exposing it in an error.
 */
export function parseSnapshotPublicKeys(value: string): SnapshotPublicKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalidKeyring();
  }
  if (!parsed || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return invalidKeyring();
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > MAX_KEYRING_KEYS) return invalidKeyring();

  const result: Record<string, string> = {};
  for (const [keyId, publicKeyBase64] of entries) {
    if (!keyId || keyId.length > MAX_KEY_ID_LENGTH || !KEY_ID_RE.test(keyId) || typeof publicKeyBase64 !== "string" ||
      !publicKeyBase64 || publicKeyBase64.length > MAX_PUBLIC_KEY_BASE64_LENGTH || publicKeyBase64.trim() !== publicKeyBase64) {
      return invalidKeyring();
    }
    try {
      if (!BASE64_RE.test(publicKeyBase64) || Buffer.from(publicKeyBase64, "base64").toString("base64") !== publicKeyBase64) {
        return invalidKeyring();
      }
      normalizePublicKey(publicKeyBase64);
    } catch {
      return invalidKeyring();
    }
    result[keyId] = publicKeyBase64;
  }
  return Object.freeze(result);
}

/** Validate a programmatic keyring with the same bounds as the environment parser. */
export function validateSnapshotPublicKeys(value: SnapshotPublicKeyring): SnapshotPublicKeyring {
  // JSON round-trip gives this path the same plain-object/string-only contract as env parsing.
  try {
    return parseSnapshotPublicKeys(JSON.stringify(value));
  } catch {
    return invalidKeyring();
  }
}

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
export function assertSnapshotTrusted(
  snapshot: Snapshot,
  trust?: string | SnapshotTrust,
): void {
  const supplied = typeof trust === "string" ? { publicKeyBase64: trust } : trust;
  const keyring = supplied?.publicKeys;
  // A configured keyring intentionally takes precedence over the legacy pin. This permits an
  // overlap deployment to retain the old variable temporarily without accepting an unlisted key.
  if (keyring) {
    const keys = validateSnapshotPublicKeys(keyring);
    const keyId = snapshot.meta.signingKeyId;
    if (!keyId || !Object.hasOwn(keys, keyId)) {
      throw new Error("snapshot signature verification failed: unknown_signing_key_id (§7.3, fail closed)");
    }
    const result = verifySnapshot(snapshot, keys[keyId]!);
    if (!result.ok) {
      throw new Error(`snapshot signature verification failed: ${result.reason} (§7.3, fail closed)`);
    }
    return;
  }

  const pinned = supplied?.publicKeyBase64 ?? process.env.MANIFOLD_SNAPSHOT_PUBLIC_KEY;
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
