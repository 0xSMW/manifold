// packages/crypto/src/index.ts
//
// Envelope-encryption primitives for Manifold (SPEC §14.3, ADR-0016 / ADR-0022).
//
// Trust model:
//   - A per-workspace 256-bit DEK (data encryption key) seals the provider secret
//     with AES-256-GCM → {iv|ciphertext|tag}. Decryption happens only inside the
//     gateway process (ADR-0022).
//   - The DEK never travels in the clear. It is wrapped by a 256-bit KEK (key
//     encryption key) held in the platform secret store; the wrapped DEK and the
//     ciphertext ride the signed snapshot, the KEK does not (ADR-0016).
//   - Virtual keys / API tokens are stored as an HMAC-SHA-256 keyed hash under a
//     server pepper (never the plaintext) with constant-time comparison at lookup.
//
// Implementation uses node:crypto only — zero external dependencies. Every
// authenticated primitive FAILS CLOSED: a tampered ciphertext, tag, iv, AAD, or a
// wrong key throws; it never returns wrong-but-plausible plaintext.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// ── Constants ────────────────────────────────────────────────────────────────

/** AES-256 key size in bytes. Both DEK and KEK are exactly this size. */
export const KEY_BYTES = 32;
/** GCM nonce (IV) size in bytes. 96-bit is the NIST-recommended GCM nonce. */
export const IV_BYTES = 12;
/** GCM authentication tag size in bytes (128-bit). */
export const TAG_BYTES = 16;

/**
 * Domain-separation AAD mixed into DEK wrapping. Binds a wrapped-DEK ciphertext to
 * the "wrap" purpose so a wrapped DEK can never be opened as (or substituted for) a
 * sealed data blob, and vice-versa, even under the same key.
 */
const DEK_WRAP_AAD: Uint8Array = utf8("manifold:dek-wrap:v1");

/**
 * AAD binding a credential ciphertext to its identity (§14.3 defense-in-depth). Because a workspace's
 * DEK is shared across all its provider credentials, a ciphertext with NO AAD is cryptographically
 * interchangeable with any other credential's ciphertext under that DEK — swapping two `credentialCiphertext`
 * fields would inject the wrong provider's secret. Sealing/opening with `credentialAad(credentialId)`
 * makes a mismatched-identity open FAIL CLOSED. CP (seal) and the gateway (open) MUST pass the SAME
 * credentialId — using this one helper keeps them in lockstep by construction.
 */
export function credentialAad(credentialId: string): Uint8Array {
  return utf8("manifold:cred:v1:" + credentialId);
}

// ── Key / input validation ───────────────────────────────────────────────────

function assertKey(k: Uint8Array, name: string): void {
  if (!(k instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array`);
  }
  if (k.length !== KEY_BYTES) {
    // Fail loudly on a wrong-length key rather than silently deriving/padding a
    // weak key — a short key is a bug or an attack, never a valid AES-256 key.
    throw new RangeError(
      `${name} must be exactly ${KEY_BYTES} bytes (AES-256); got ${k.length}`,
    );
  }
}

// ── AES-256-GCM seal / open ──────────────────────────────────────────────────

/**
 * Seal `plaintext` under a 256-bit `dek` with AES-256-GCM.
 * Returns the packed layout `iv(12) | ciphertext | tag(16)`.
 * A fresh random IV is drawn per call, so two seals of identical plaintext under
 * the same key differ (no ECB-style determinism / no IV reuse).
 */
export function sealAesGcm(
  dek: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  assertKey(dek, "dek");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dek, iv, {
    authTagLength: TAG_BYTES,
  });
  if (aad !== undefined && aad.length > 0) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

/**
 * Open a packed `iv | ciphertext | tag` blob under `dek`.
 * THROWS on any authentication failure — wrong key, tampered ciphertext / iv /
 * tag, or an AAD that differs from the one used to seal. Never returns wrong
 * plaintext silently (GCM integrity).
 */
export function openAesGcm(
  dek: Uint8Array,
  packed: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  assertKey(dek, "dek");
  if (packed.length < IV_BYTES + TAG_BYTES) {
    throw new RangeError(
      `openAesGcm: packed blob too short (${packed.length} < ${IV_BYTES + TAG_BYTES})`,
    );
  }
  // Copy into a Buffer so we own the memory and byteOffset math is trivial.
  const buf = Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", dek, iv, {
    authTagLength: TAG_BYTES,
  });
  if (aad !== undefined && aad.length > 0) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  // final() verifies the tag and throws ("Unsupported state or unable to
  // authenticate data") if it does not match — this is the fail-closed point.
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── DEK wrapping (envelope) ──────────────────────────────────────────────────

/**
 * Wrap a 256-bit `dek` under a 256-bit `kek` (AES-256-GCM), producing the packed
 * blob that lives in `data_encryption_key` / the snapshot. Domain-separated from
 * data sealing via a fixed AAD.
 */
export function wrapDek(kek: Uint8Array, dek: Uint8Array): Uint8Array {
  assertKey(kek, "kek");
  assertKey(dek, "dek");
  return sealAesGcm(kek, dek, DEK_WRAP_AAD);
}

/**
 * Unwrap a KEK-wrapped DEK. THROWS on a tampered blob or a wrong KEK. Additionally
 * asserts the recovered DEK is exactly 32 bytes, so a truncated/forged-but-somehow-
 * authenticating blob can never yield a weak key.
 */
export function unwrapDek(kek: Uint8Array, wrapped: Uint8Array): Uint8Array {
  assertKey(kek, "kek");
  const dek = openAesGcm(kek, wrapped, DEK_WRAP_AAD);
  if (dek.length !== KEY_BYTES) {
    throw new RangeError(
      `unwrapDek: recovered DEK is not ${KEY_BYTES} bytes (got ${dek.length})`,
    );
  }
  return dek;
}

// ── Keyed hashing for virtual keys / tokens ──────────────────────────────────

/**
 * HMAC-SHA-256 keyed hash of `plaintext` under a server `pepper` (SPEC §14.3).
 * Used to store virtual keys / API tokens as a hash + prefix, never the key.
 * Deterministic for a given (pepper, plaintext); a different pepper yields a
 * different hash. Returns 32 raw bytes.
 */
export function hmacKeyHash(pepper: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (!(pepper instanceof Uint8Array) || pepper.length === 0) {
    throw new TypeError("hmacKeyHash: pepper must be a non-empty Uint8Array");
  }
  return createHmac("sha256", pepper).update(plaintext).digest();
}

/**
 * Constant-time comparison of two hex strings. Length-safe: returns `false`
 * (rather than throwing) when the decoded lengths differ, and never short-circuits
 * on content. Use for comparing a presented-key hash against a stored hash.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Reject non-even / non-hex input deterministically before decode.
  if (!isHex(a) || !isHex(b)) return false;
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  // Lengths are equal here, so timingSafeEqual will not throw.
  return timingSafeEqual(ab, bb);
}

// ── Base64 pack/unpack for snapshot transport ────────────────────────────────

/** Encode raw bytes as base64 for snapshot transport (ciphertext, wrapped DEK). */
export function packBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64",
  );
}

/** Decode a base64 string produced by {@link packBase64} back to raw bytes. */
export function unpackBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ── Dev-default key material & env resolvers ─────────────────────────────────
//
// The pepper and the data KEK are BOTH shared control-plane ↔ gateway secrets:
//   - The control plane mints virtual keys / API tokens and stores their HMAC
//     keyed_hash under the pepper; the gateway re-hashes a presented key under the
//     SAME pepper to authenticate it. A mismatch makes every CP-minted key unknown.
//   - The control plane seals a credential under a fresh DEK wrapped by the KEK; the
//     gateway unwraps with the SAME KEK to decrypt in-proc. A mismatch fails decrypt.
// Because both sides must resolve identical material, the dev defaults and the env
// resolvers are owned here, once, and imported by both apps (SPEC §14.3).

/** Dev-only pepper. Production supplies MANIFOLD_KEY_PEPPER (a rotatable secret, §14.3). */
export const DEV_PEPPER = "dev-pepper-not-for-production";

/** Dev-only KEK (all-zero 32 bytes) for local runs without MANIFOLD_DATA_KEK. */
export const DEV_KEK: Uint8Array = new Uint8Array(KEY_BYTES);

/**
 * The dev pepper/KEK fallbacks are publicly known (the KEK is all-zero). A production deploy that
 * forgets MANIFOLD_KEY_PEPPER / MANIFOLD_DATA_KEK must FAIL CLOSED rather than silently boot with dev
 * material — which would make every wrapped DEK trivially unwrappable and virtual-key hashes forgeable
 * (review SSRF-MEDIUM). Mirrors the snapshot-verify fail-closed-in-prod contract. Set
 * MANIFOLD_REQUIRE_REAL_KEYS=1 to enforce this outside NODE_ENV=production too.
 */
function requireRealKeys(): boolean {
  return process.env.NODE_ENV === "production" || process.env.MANIFOLD_REQUIRE_REAL_KEYS === "1";
}

/**
 * Resolve the key pepper (a UTF-8 string) from its env value (MANIFOLD_KEY_PEPPER),
 * falling back to {@link DEV_PEPPER} when unset. Callers UTF-8-encode the result for
 * {@link hmacKeyHash}. FAILS CLOSED in production when unset (never the dev pepper).
 */
export function resolveKeyPepper(pepperEnv: string | undefined): string {
  // Guard the UNSET case only, preserving `??` semantics: an explicit "" stays "" and is rejected
  // loudly downstream by hmacKeyHash's empty-pepper guard.
  if (pepperEnv === undefined && requireRealKeys()) {
    throw new Error("MANIFOLD_KEY_PEPPER is required in production (refusing the dev pepper)");
  }
  return pepperEnv ?? DEV_PEPPER;
}

/**
 * Resolve the 256-bit data KEK from its env value (MANIFOLD_DATA_KEK, base64 of
 * exactly 32 bytes), falling back to {@link DEV_KEK} when unset. THROWS on a
 * wrong-length key rather than deriving a weak one, and FAILS CLOSED in production
 * when unset (never the all-zero dev KEK).
 */
export function resolveDataKek(kekEnv: string | undefined): Uint8Array {
  if (!kekEnv) {
    if (requireRealKeys()) {
      throw new Error("MANIFOLD_DATA_KEK is required in production (refusing the all-zero dev KEK)");
    }
    return DEV_KEK;
  }
  const k = unpackBase64(kekEnv);
  if (k.length !== KEY_BYTES) {
    throw new Error("MANIFOLD_DATA_KEK must be base64 of exactly 32 bytes");
  }
  return k;
}

// ── Small utilities ──────────────────────────────────────────────────────────

/** Encode a hex string from raw bytes (e.g. to store an HMAC hash). */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "hex",
  );
}

/** UTF-8 encode a string to bytes. */
export function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "utf8"));
}

function isHex(s: string): boolean {
  return s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s);
}
