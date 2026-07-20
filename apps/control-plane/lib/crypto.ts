// Keyed hashing + secret generation for api_tokens and virtual keys (SPEC §14.3).
//
// keyed_hash = HMAC-SHA256(pepper, plaintext). The pepper is a control-plane/gateway
// secret (MANIFOLD_TOKEN_PEPPER). Lookup is by hash only; plaintext is never stored — a
// virtual key / api_token is a keyed hash + display prefix (SPEC §5.5).
import { createHmac, randomBytes } from "node:crypto";

function pepper(): string {
  const p = process.env.MANIFOLD_TOKEN_PEPPER;
  if (!p) {
    // Deterministic dev default so the seed route and auth agree in a dev DB. Production
    // MUST set MANIFOLD_TOKEN_PEPPER (rotatable, versioned per §14.3).
    return "manifold-dev-pepper-do-not-use-in-prod";
  }
  return p;
}

/** keyed_hash = HMAC-SHA256(pepper, plaintext) → 32-byte Buffer (stored as bytea). */
export function keyedHash(plaintext: string): Buffer {
  return createHmac("sha256", pepper()).update(plaintext, "utf8").digest();
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
