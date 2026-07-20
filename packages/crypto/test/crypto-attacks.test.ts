// packages/crypto/test/crypto-attacks.test.ts
//
// Adversarial tests for @manifold/crypto. Each test is a REAL run against the real
// node:crypto-backed implementation — no mocks, no stubs. The theme: the module
// must FAIL CLOSED. A tampered ciphertext / tag / iv, a wrong key, or a mismatched
// AAD must THROW; it must never return wrong-but-plausible plaintext.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  DEV_KEK,
  DEV_PEPPER,
  IV_BYTES,
  KEY_BYTES,
  TAG_BYTES,
  hmacKeyHash,
  openAesGcm,
  packBase64,
  resolveDataKek,
  resolveKeyPepper,
  sealAesGcm,
  timingSafeEqualHex,
  toHex,
  unpackBase64,
  unwrapDek,
  utf8,
  wrapDek,
} from "../src/index.js";

// A realistic secret: an Anthropic-style provider key (the thing §14.3 protects).
const SECRET = utf8("sk-ant-api03-" + "A".repeat(80));

function key(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

/** Flip one bit of a copy at `index`, returning a new array (never mutate input). */
function flipBit(bytes: Uint8Array, index: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  const b = out[index];
  assert.notEqual(b, undefined, "flipBit: index in range");
  out[index] = (b as number) ^ 0x01;
  return out;
}

// ── 1. Round-trip returns the EXACT plaintext ────────────────────────────────

test("1. seal/open round-trips to the exact plaintext", () => {
  const dek = key();
  const packed = sealAesGcm(dek, SECRET);

  // Layout sanity: iv(12) | ciphertext | tag(16); ciphertext length == plaintext.
  assert.equal(packed.length, IV_BYTES + SECRET.length + TAG_BYTES);

  const out = openAesGcm(dek, packed);
  assert.deepEqual(Uint8Array.from(out), SECRET);

  // Empty plaintext must also round-trip (edge case).
  const emptyPacked = sealAesGcm(dek, new Uint8Array(0));
  assert.equal(emptyPacked.length, IV_BYTES + TAG_BYTES);
  assert.deepEqual(Uint8Array.from(openAesGcm(dek, emptyPacked)), new Uint8Array(0));
});

// ── 2. Tamper ANY ciphertext byte → THROWS, never wrong plaintext ────────────

test("2. tampering any ciphertext byte makes open() throw (never silent)", () => {
  const dek = key();
  const packed = sealAesGcm(dek, SECRET);

  const ctStart = IV_BYTES;
  const ctEnd = packed.length - TAG_BYTES;

  // Exhaustively flip every single ciphertext byte; each must throw.
  for (let i = ctStart; i < ctEnd; i++) {
    const tampered = flipBit(packed, i);
    assert.throws(
      () => openAesGcm(dek, tampered),
      /./,
      `ciphertext byte ${i} tamper should throw`,
    );
  }
});

// ── 3. Tamper the tag or the iv → THROWS ─────────────────────────────────────

test("3. tampering the tag or the iv makes open() throw", () => {
  const dek = key();
  const packed = sealAesGcm(dek, SECRET);

  // Every tag byte.
  for (let i = packed.length - TAG_BYTES; i < packed.length; i++) {
    assert.throws(() => openAesGcm(dek, flipBit(packed, i)), `tag byte ${i}`);
  }
  // Every iv byte — a changed nonce yields a different keystream → tag mismatch.
  for (let i = 0; i < IV_BYTES; i++) {
    assert.throws(() => openAesGcm(dek, flipBit(packed, i)), `iv byte ${i}`);
  }
});

// ── 4. Wrong DEK → THROWS ────────────────────────────────────────────────────

test("4. opening with the wrong DEK throws (no cross-key decrypt)", () => {
  const dek = key();
  const wrong = key();
  const packed = sealAesGcm(dek, SECRET);
  assert.throws(() => openAesGcm(wrong, packed));
});

// ── 5. AAD mismatch → THROWS ─────────────────────────────────────────────────

test("5. AAD mismatch (seal A, open B) throws; correct AAD opens", () => {
  const dek = key();
  const aadA = utf8("workspace:alpha");
  const aadB = utf8("workspace:beta");
  const packed = sealAesGcm(dek, SECRET, aadA);

  assert.throws(() => openAesGcm(dek, packed, aadB), "different AAD");
  assert.throws(() => openAesGcm(dek, packed), "missing AAD");
  // Correct AAD still opens to the exact plaintext.
  assert.deepEqual(Uint8Array.from(openAesGcm(dek, packed, aadA)), SECRET);
});

// ── 6. wrap/unwrap DEK round-trips; tampered wrapped DEK → THROWS ─────────────

test("6. wrapDek/unwrapDek round-trips; tampered wrapped DEK throws", () => {
  const kek = key();
  const dek = key();

  const wrapped = wrapDek(kek, dek);
  assert.deepEqual(Uint8Array.from(unwrapDek(kek, wrapped)), dek);

  // Tamper each byte of the wrapped blob → unwrap must throw.
  for (let i = 0; i < wrapped.length; i++) {
    assert.throws(() => unwrapDek(kek, flipBit(wrapped, i)), `wrapped byte ${i}`);
  }
  // Wrong KEK cannot unwrap.
  assert.throws(() => unwrapDek(key(), wrapped), "wrong KEK");

  // Domain separation: a wrapped DEK must NOT open as a plain sealed blob (no AAD),
  // and a plain sealed blob must NOT unwrap as a DEK.
  assert.throws(() => openAesGcm(kek, wrapped), "wrapped DEK is not a data blob");
  const plain = sealAesGcm(kek, dek);
  assert.throws(() => unwrapDek(kek, plain), "data blob is not a wrapped DEK");
});

// ── 7. Wrong-length key → CLEAR error, not a silent weak key ─────────────────

test("7. non-32-byte keys are rejected loudly (no silent weak key)", () => {
  const dek = key();
  const packed = sealAesGcm(dek, SECRET);

  for (const badLen of [0, 1, 16, 24, 31, 33, 64]) {
    const bad = new Uint8Array(badLen);
    assert.throws(
      () => sealAesGcm(bad, SECRET),
      /exactly 32 bytes/,
      `seal rejects ${badLen}-byte key`,
    );
    assert.throws(
      () => openAesGcm(bad, packed),
      /exactly 32 bytes/,
      `open rejects ${badLen}-byte key`,
    );
    assert.throws(() => wrapDek(bad, dek), /exactly 32 bytes/, `wrap rejects ${badLen}-byte KEK`);
    assert.throws(() => wrapDek(dek, bad), /exactly 32 bytes/, `wrap rejects ${badLen}-byte DEK`);
  }
});

// ── 8. hmacKeyHash determinism + pepper sensitivity; timingSafeEqualHex ──────

test("8. hmacKeyHash is deterministic & pepper-sensitive; timingSafeEqualHex", () => {
  const pepperA = key();
  const pepperB = key();
  const vkey = utf8("mk-live-abc123");

  const h1 = toHex(hmacKeyHash(pepperA, vkey));
  const h2 = toHex(hmacKeyHash(pepperA, vkey));
  assert.equal(h1, h2, "same (pepper, key) → identical hash (deterministic)");
  assert.equal(hmacKeyHash(pepperA, vkey).length, 32, "HMAC-SHA-256 → 32 bytes");

  const hB = toHex(hmacKeyHash(pepperB, vkey));
  assert.notEqual(h1, hB, "different pepper → different hash");

  const hOther = toHex(hmacKeyHash(pepperA, utf8("mk-live-different")));
  assert.notEqual(h1, hOther, "different plaintext → different hash");

  // Empty pepper is rejected (would be a silent weak keyed-hash).
  assert.throws(() => hmacKeyHash(new Uint8Array(0), vkey), /non-empty/);

  // Constant-time hex compare: correctness both ways.
  assert.equal(timingSafeEqualHex(h1, h2), true, "equal hashes → true");
  assert.equal(timingSafeEqualHex(h1, hB), false, "unequal hashes → false");
  // Length-safe: differing lengths return false rather than throwing.
  assert.equal(timingSafeEqualHex(h1, h1 + "ab"), false, "different length → false");
  assert.equal(timingSafeEqualHex("", ""), true, "empty vs empty → true");
  // Non-hex / odd-length input is rejected deterministically (no throw).
  assert.equal(timingSafeEqualHex("zz", "zz"), false, "non-hex → false");
  assert.equal(timingSafeEqualHex("abc", "abc"), false, "odd length → false");
});

// ── Non-determinism: two seals of the same plaintext differ (random IV) ───────

test("two seals of the same plaintext differ (random IV, no ECB determinism)", () => {
  const dek = key();
  const a = sealAesGcm(dek, SECRET);
  const b = sealAesGcm(dek, SECRET);

  assert.notDeepEqual(Uint8Array.from(a), Uint8Array.from(b), "packed blobs differ");
  // Specifically the IV differs...
  assert.notDeepEqual(
    Uint8Array.from(a.subarray(0, IV_BYTES)),
    Uint8Array.from(b.subarray(0, IV_BYTES)),
    "IVs differ",
  );
  // ...and so does the ciphertext body (keystream reuse would be catastrophic).
  assert.notDeepEqual(
    Uint8Array.from(a.subarray(IV_BYTES, a.length - TAG_BYTES)),
    Uint8Array.from(b.subarray(IV_BYTES, b.length - TAG_BYTES)),
    "ciphertext bodies differ",
  );
  // Both still open to the same plaintext.
  assert.deepEqual(Uint8Array.from(openAesGcm(dek, a)), SECRET);
  assert.deepEqual(Uint8Array.from(openAesGcm(dek, b)), SECRET);
});

// ── Base64 snapshot transport round-trips (ciphertext + wrapped DEK) ──────────

test("base64 pack/unpack round-trips ciphertext through snapshot transport", () => {
  const kek = key();
  const dek = key();
  const ciphertext = sealAesGcm(dek, SECRET);
  const wrapped = wrapDek(kek, dek);

  // Simulate the snapshot carrying base64 strings (ADR-0022).
  const ctB64 = packBase64(ciphertext);
  const wrappedB64 = packBase64(wrapped);
  assert.equal(typeof ctB64, "string");

  const dek2 = unwrapDek(kek, unpackBase64(wrappedB64));
  const secret2 = openAesGcm(dek2, unpackBase64(ctB64));
  assert.deepEqual(Uint8Array.from(secret2), SECRET);
});

// review SSRF-MEDIUM: the dev pepper/KEK fallbacks are publicly known (the KEK is all-zero). A prod
// deploy that forgets the env var must FAIL CLOSED, not silently boot with dev material (which makes
// every wrapped DEK unwrappable and virtual-key hashes forgeable). Guarded by NODE_ENV=production or
// MANIFOLD_REQUIRE_REAL_KEYS=1.
test("resolveDataKek/resolveKeyPepper: dev fallback in dev, FAIL CLOSED in production", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedFlag = process.env.MANIFOLD_REQUIRE_REAL_KEYS;
  try {
    // Dev (not production, flag unset): unset env ⇒ dev fallbacks (unchanged behavior).
    delete process.env.NODE_ENV;
    delete process.env.MANIFOLD_REQUIRE_REAL_KEYS;
    assert.deepEqual(resolveDataKek(undefined), DEV_KEK, "dev: unset KEK ⇒ all-zero DEV_KEK");
    assert.equal(resolveKeyPepper(undefined), DEV_PEPPER, "dev: unset pepper ⇒ DEV_PEPPER");

    // Production + unset ⇒ THROW (never dev material).
    process.env.NODE_ENV = "production";
    assert.throws(() => resolveDataKek(undefined), /required in production/, "prod: unset KEK must throw");
    assert.throws(() => resolveKeyPepper(undefined), /required in production/, "prod: unset pepper must throw");
    // A REAL 32-byte KEK / real pepper still resolves in production.
    const realKek = packBase64(new Uint8Array(KEY_BYTES).fill(7));
    assert.equal(resolveDataKek(realKek).length, KEY_BYTES, "prod: a real 32-byte KEK resolves");
    assert.equal(resolveKeyPepper("real-pepper"), "real-pepper", "prod: a real pepper resolves");

    // The explicit opt-in flag enforces it outside production too.
    delete process.env.NODE_ENV;
    process.env.MANIFOLD_REQUIRE_REAL_KEYS = "1";
    assert.throws(() => resolveDataKek(undefined), /required in production/, "flag: unset KEK must throw");
    assert.throws(() => resolveKeyPepper(undefined), /required in production/, "flag: unset pepper must throw");
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedFlag === undefined) delete process.env.MANIFOLD_REQUIRE_REAL_KEYS;
    else process.env.MANIFOLD_REQUIRE_REAL_KEYS = savedFlag;
  }
});
