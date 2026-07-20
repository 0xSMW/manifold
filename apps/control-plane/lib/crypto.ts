// Keyed hashing + secret generation for api_tokens and virtual keys (SPEC §14.3).
//
// keyed_hash = HMAC-SHA256(pepper, plaintext). The pepper is a SHARED control-plane/gateway
// secret: the control plane mints keys and stores their keyed_hash; the gateway authenticates a
// presented key by recomputing that same hash. They MUST use the same env var and the same dev
// default, or every CP-minted key is AUTH_KEY_UNKNOWN at the gateway. The gateway reads
// MANIFOLD_KEY_PEPPER (apps/gateway/src/server.ts, DEV_PEPPER = "dev-pepper-not-for-production");
// we mirror both here exactly. Lookup is by hash only; plaintext is never stored (SPEC §5.5).
import { randomBytes } from "node:crypto";
import { DEV_PEPPER, hmacKeyHash, resolveKeyPepper } from "@manifold/crypto";

// DEV_PEPPER and the pepper resolver are owned once by @manifold/crypto so this control plane
// (which stores keyed_hash) and the gateway (which re-hashes to authenticate) resolve the SAME
// pepper — a mismatch makes every CP-minted key AUTH_KEY_UNKNOWN. Re-exported to preserve surface.
export { DEV_PEPPER };

function pepper(): string {
  // Deterministic dev default so the seed route, key minting, and the gateway all agree in a dev
  // DB. Production MUST set MANIFOLD_KEY_PEPPER (the gateway-shared secret, rotatable §14.3).
  return resolveKeyPepper(process.env.MANIFOLD_KEY_PEPPER);
}

/**
 * keyed_hash = HMAC-SHA256(pepper, plaintext) → 32-byte Buffer (stored as bytea).
 *
 * Delegates to @manifold/crypto's `hmacKeyHash`, which owns the attack-tested primitive.
 * That helper takes bytes for both pepper and plaintext, whereas the control-plane pepper is a
 * string secret (MANIFOLD_TOKEN_PEPPER); we encode it as UTF-8 — exactly what `createHmac`'s
 * string-key path did — so the resulting hash bytes are byte-for-byte identical (token auth and
 * the stored keyed_hash stay compatible). Wrapped in Buffer.from for the bytea encoder.
 */
export function keyedHash(plaintext: string): Buffer {
  return Buffer.from(
    hmacKeyHash(Buffer.from(pepper(), "utf8"), Buffer.from(plaintext, "utf8")),
  );
}

export interface GeneratedSecret {
  plaintext: string;
  displayPrefix: string;
  keyedHash: Buffer;
}

/**
 * Mint a fresh secret with the given human prefix (e.g. "mf_tok_", "sk-mf-").
 * Returns the plaintext (shown once), a display prefix for the UI, and the keyed hash to store.
 */
export function generateSecret(prefix: string): GeneratedSecret {
  const random = randomBytes(24).toString("base64url");
  const plaintext = `${prefix}${random}`;
  return {
    plaintext,
    displayPrefix: plaintext.slice(0, 12),
    keyedHash: keyedHash(plaintext),
  };
}
