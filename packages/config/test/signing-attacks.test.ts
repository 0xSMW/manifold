// Adversarial tests for @manifold/config snapshot signing/verification (SPEC §7.3, ADR-0024).
//
// These are NOT happy-path unit tests: every case below constructs a REAL ed25519-signed
// snapshot and then ATTACKS `verifySnapshot`, asserting the forged/tampered input is REJECTED
// with the correct reason. The single positive round-trip at the bottom exists so the negative
// results mean something (proves verify CAN say yes, so its "no" is discriminating).
//
// Security invariant under test: given a TRUSTED pinned public key, no attacker-supplied
// snapshot is ever accepted (ok:true) unless it carries a correct signature over the correct
// content hash. verify must fail CLOSED — never accept-by-default, never crash-as-accept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  signSnapshot,
  verifySnapshot,
  generateSigningKeyPair,
  computeContentHash,
  canonicalBody,
  rawPublicKey,
  type ConfigSnapshot,
} from "@manifold/config";

// ── A realistic, fully-populated snapshot body. Every attack starts from a fresh copy so
//    tests never share mutable state. Values are plausible §7.2 content (a hashed-key map,
//    an ordered route with an encrypted target, an offering, a policy).
function freshSnapshot(): ConfigSnapshot {
  return {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId: "inst_alpha",
      revision: "rev_0001",
      contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      builtAt: "2026-07-20T00:00:00.000Z",
      signature: "",
      signingKeyId: "key_unset",
    },
    profiles: {
      "app.example.com": {
        id: "prof_public",
        mode: "public_app",
        policyRevision: "pol_rev_1",
        defaultRouteSet: "rs_default",
      },
    },
    keys: {
      // key = hex(HMAC(pepper, presentedKey)); the map key IS a "key hash" per §7.2.
      "9f8c1b2a3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8": {
        id: "vk_001",
        profileId: "prof_public",
        scopes: ["chat.completions"],
        allowedAppIds: ["app_1"],
        budgetAccountId: "budget_1",
        expiresAt: null,
        revoked: false,
      },
    },
    routes: {
      "prof_public:/v1/chat/completions": {
        routeId: "route_chat",
        revision: "rt_rev_1",
        mode: "ordered",
        targets: [
          {
            offeringId: "off_anthropic_sonnet",
            credentialId: "cred_1",
            dekId: "dek_1",
            credentialCiphertext: "AAAAAAAAAAAAAAAAAAAAAA==",
            wrappedDek: "BBBBBBBBBBBBBBBBBBBBBB==",
            weight: 100,
            priority: 0,
            baseUrl: "https://api.anthropic.com",
            region: "us-east-1",
            allowedHosts: ["api.anthropic.com"],
            authInject: { headers: { "x-api-key": "${secret}", "anthropic-version": "2023-06-01" } },
            secretEnv: null,
          },
        ],
        timeoutMs: 30000,
        capturePolicyId: "cap_default",
      },
    },
    offerings: {
      off_anthropic_sonnet: {
        provider: "anthropic",
        providerModelId: "claude-sonnet-4-5",
        adapterRevision: "adp_1",
        region: "us-east-1",
        priceRevisionId: "price_1",
        priceFidelity: "provider_verified",
        capabilities: { streaming: true },
        baseUrl: "https://api.anthropic.com",
      },
    },
    policies: {
      pol_rev_1: {
        entitlements: [
          { subjectKind: "key", subjectRef: "vk_001", canonicalModelId: null, offeringId: "off_anthropic_sonnet", effect: "allow" },
        ],
        entitlementIndex: { "key:vk_001": ["off_anthropic_sonnet"] },
        requestConstraints: [{ param: "max_tokens", maxValue: "4096", minValue: null, onViolation: "reject" }],
        dataHandling: [{ captureMode: "metadata_only", redaction: null, allowedRegions: ["us-east-1"] }],
      },
    },
  };
}

// A stable keypair used as the "pinned" signer for most attacks.
const PINNED = generateSigningKeyPair();

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE ROUND-TRIP — verify CAN accept a correctly signed snapshot. Without this,
// the rejections below would be meaningless (a verifier that always says "no" is useless).
// Exercises all three pinned-key input forms (KeyObject, base64 string, raw Uint8Array).
// ─────────────────────────────────────────────────────────────────────────────
test("round-trip: sign then verify against pinned public key → OK", () => {
  const signed = signSnapshot(freshSnapshot(), PINNED.privateKey, PINNED.signingKeyId);

  // signSnapshot must have populated a real signature + content hash.
  assert.notEqual(signed.meta.signature, "", "signature must be set");
  assert.equal(signed.meta.contentHash, computeContentHash(freshSnapshot()), "content hash over body");
  assert.equal(signed.meta.signingKeyId, PINNED.signingKeyId);

  // KeyObject form.
  assert.deepEqual(verifySnapshot(signed, PINNED.publicKey), { ok: true });
  // base64-string form (the MANIFOLD_SNAPSHOT_PUBLIC_KEY env path).
  assert.deepEqual(verifySnapshot(signed, PINNED.publicKeyBase64), { ok: true });
  // raw 32-byte Uint8Array form.
  assert.deepEqual(verifySnapshot(signed, new Uint8Array(rawPublicKey(PINNED.publicKey))), { ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 1 — Tamper the signed body. Flip content the signature commits to (a route
// target and, separately, a key-hash map entry). Recomputed hash must diverge → rejected
// with content_hash_mismatch, BEFORE the signature is even consulted.
// ─────────────────────────────────────────────────────────────────────────────
test("attack 1a: tamper a route target after signing → content_hash_mismatch", () => {
  const signed = signSnapshot(freshSnapshot(), PINNED.privateKey);
  // Flip a byte in the target's offeringId — a hot-path routing decision.
  const route = signed.routes["prof_public:/v1/chat/completions"];
  assert.ok(route?.targets[0]);
  route.targets[0].offeringId = "off_anthropic_sannet"; // o→a

  assert.deepEqual(verifySnapshot(signed, PINNED.publicKey), {
    ok: false,
    reason: "content_hash_mismatch",
  });
});

test("attack 1b: tamper a key-hash map entry after signing → content_hash_mismatch", () => {
  const signed = signSnapshot(freshSnapshot(), PINNED.privateKey);
  // Redirect an existing hashed-key entry to a different (attacker) profile.
  const [hash] = Object.keys(signed.keys);
  assert.ok(hash && signed.keys[hash]);
  signed.keys[hash].profileId = "prof_attacker";

  assert.deepEqual(verifySnapshot(signed, PINNED.publicKey), {
    ok: false,
    reason: "content_hash_mismatch",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 2 — Forge with a DIFFERENT keypair. Body is untouched (hash matches), but the
// signature is produced by a key the gateway did not pin. Verifying against the pinned key
// must fail the signature check → bad_signature.
// ─────────────────────────────────────────────────────────────────────────────
test("attack 2: re-sign with a different keypair → bad_signature", () => {
  const attacker = generateSigningKeyPair();
  const forged = signSnapshot(freshSnapshot(), attacker.privateKey);

  // Sanity: the content hash IS valid (attacker recomputed it), so this reaches the
  // signature check rather than tripping content_hash_mismatch.
  assert.equal(forged.meta.contentHash, computeContentHash(freshSnapshot()));

  assert.deepEqual(verifySnapshot(forged, PINNED.publicKey), {
    ok: false,
    reason: "bad_signature",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 3 — Strip the signature. Empty string and missing property must both be rejected
// (no_signature) and NEVER accepted-by-default. A truthy content hash must not be enough.
// ─────────────────────────────────────────────────────────────────────────────
test("attack 3a: empty signature → no_signature (never accept)", () => {
  const signed = signSnapshot(freshSnapshot(), PINNED.privateKey);
  signed.meta.signature = ""; // strip

  const r = verifySnapshot(signed, PINNED.publicKey);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_signature");
});

test("attack 3b: missing signature property → no_signature (never accept)", () => {
  const signed = signSnapshot(freshSnapshot(), PINNED.privateKey);
  // Delete the property entirely, as a malformed/truncated blob might arrive.
  delete (signed.meta as { signature?: string }).signature;

  const r = verifySnapshot(signed, PINNED.publicKey);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_signature");
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 4 — Signature reuse / replay. Take a valid signature from snapshot A and paste it
// onto a DIFFERENT snapshot B. Both forms must be rejected:
//   (i)  keep B's own content hash  → signature is over A's hash ≠ B's hash → bad_signature
//   (ii) also copy A's content hash → recomputed(B) ≠ claimed hash        → content_hash_mismatch
// A single lifted signature can never validate a body it wasn't produced for.
// ─────────────────────────────────────────────────────────────────────────────
test("attack 4: replay a signature onto a different snapshot → rejected", () => {
  const snapA = signSnapshot(freshSnapshot(), PINNED.privateKey);

  const bodyB = freshSnapshot();
  bodyB.routes["prof_public:/v1/chat/completions"].targets[0].weight = 55; // B differs from A
  const snapB = signSnapshot(bodyB, PINNED.privateKey);
  assert.notEqual(snapA.meta.contentHash, snapB.meta.contentHash, "A and B must differ");

  // (i) lift A's signature onto B, keep B's real content hash.
  const replayKeepHash: ConfigSnapshot = {
    ...snapB,
    meta: { ...snapB.meta, signature: snapA.meta.signature },
  };
  assert.deepEqual(verifySnapshot(replayKeepHash, PINNED.publicKey), {
    ok: false,
    reason: "bad_signature",
  });

  // (ii) lift BOTH A's signature and A's content hash onto B's body.
  const replaySwapHash: ConfigSnapshot = {
    ...snapB,
    meta: { ...snapB.meta, signature: snapA.meta.signature, contentHash: snapA.meta.contentHash },
  };
  assert.deepEqual(verifySnapshot(replaySwapHash, PINNED.publicKey), {
    ok: false,
    reason: "content_hash_mismatch",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 5 — Canonicalization. Content hash must be a pure function of CONTENT, immune to
// key ordering and JSON whitespace, yet SENSITIVE to any real content change. Otherwise an
// attacker could reshape bytes without breaking the signature, or two distinct bodies could
// collide under one signature.
// ─────────────────────────────────────────────────────────────────────────────
test("attack 5a: reordered keys / whitespace canonicalize to the SAME hash", () => {
  const base = freshSnapshot();
  const h1 = computeContentHash(base);

  // Rebuild the exact same content but with top-level and nested keys inserted in a
  // different order, and route through a whitespace-laden JSON string round-trip.
  const target = base.routes["prof_public:/v1/chat/completions"].targets[0];
  const reordered = {
    // deliberately different insertion order than freshSnapshot()
    policies: base.policies,
    offerings: base.offerings,
    routes: {
      "prof_public:/v1/chat/completions": {
        capturePolicyId: "cap_default",
        timeoutMs: 30000,
        targets: [
          {
            secretEnv: null,
            authInject: { headers: { "anthropic-version": "2023-06-01", "x-api-key": "${secret}" } },
            allowedHosts: ["api.anthropic.com"],
            region: "us-east-1",
            baseUrl: "https://api.anthropic.com",
            priority: 0,
            weight: 100,
            wrappedDek: target.wrappedDek,
            credentialCiphertext: target.credentialCiphertext,
            dekId: "dek_1",
            credentialId: "cred_1",
            offeringId: "off_anthropic_sonnet",
          },
        ],
        mode: "ordered",
        revision: "rt_rev_1",
        routeId: "route_chat",
      },
    },
    keys: base.keys,
    profiles: base.profiles,
    meta: base.meta,
  };
  // Force a whitespace-different serialization, then parse back — proves the hash depends on
  // structure, not on the byte layout of any particular JSON encoding.
  const whitespaced = JSON.parse(JSON.stringify(reordered, null, 4)) as ConfigSnapshot;
  const h2 = computeContentHash(whitespaced);

  assert.equal(h2, h1, "reordered keys + whitespace must not change the content hash");
  // And a snapshot signed over one ordering verifies even after the other ordering is loaded.
  const signed = signSnapshot(base, PINNED.privateKey);
  const asReordered: ConfigSnapshot = { ...whitespaced, meta: signed.meta };
  assert.deepEqual(verifySnapshot(asReordered, PINNED.publicKey), { ok: true });
});

test("attack 5b: a genuinely different body yields a DIFFERENT hash", () => {
  const a = freshSnapshot();
  const b = freshSnapshot();
  b.routes["prof_public:/v1/chat/completions"].targets[0].weight = 99; // one field changed
  assert.notEqual(computeContentHash(a), computeContentHash(b));
  // canonicalBody strings must differ too (the hash difference isn't a fluke of formatting).
  assert.notEqual(canonicalBody(a), canonicalBody(b));
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 6 — Malformed inputs must fail CLOSED: reject (ok:false) or throw, but NEVER return
// ok:true. A garbage signature must not crash-as-accept; a broken pinned key must not silently
// pass.
// ─────────────────────────────────────────────────────────────────────────────
test("attack 6a: non-base64 signature → bad_signature (no crash, no accept)", () => {
  const signed = signSnapshot(freshSnapshot(), PINNED.privateKey);
  signed.meta.signature = "!!! this is not base64 @#$%^&*() !!!";

  const r = verifySnapshot(signed, PINNED.publicKey);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_signature");
});

test("attack 6b: valid-base64 but wrong-length signature → bad_signature", () => {
  const signed = signSnapshot(freshSnapshot(), PINNED.privateKey);
  // Well-formed base64 that decodes to 10 bytes — not a 64-byte ed25519 signature.
  signed.meta.signature = Buffer.alloc(10, 7).toString("base64");

  const r = verifySnapshot(signed, PINNED.publicKey);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_signature");
});

test("attack 6c: all-zero 64-byte signature → bad_signature", () => {
  const signed = signSnapshot(freshSnapshot(), PINNED.privateKey);
  signed.meta.signature = Buffer.alloc(64, 0).toString("base64");

  const r = verifySnapshot(signed, PINNED.publicKey);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_signature");
});

test("attack 6d: truncated / wrong-length pinned key fails CLOSED (never ok:true)", () => {
  const signed = signSnapshot(freshSnapshot(), PINNED.privateKey);
  // Take the real 32-byte public key and truncate it — an invalid ed25519 key.
  const truncated = new Uint8Array(rawPublicKey(PINNED.publicKey).subarray(0, 31));

  // The key parser rejects a malformed key by throwing (fail-closed). The security invariant
  // is only that it must NOT return ok:true. Assert exactly that: a rejection, never an accept.
  let result: { ok: boolean } | undefined;
  let threw = false;
  try {
    result = verifySnapshot(signed, truncated);
  } catch {
    threw = true;
  }
  assert.ok(threw || result?.ok === false, "wrong-length key must reject or throw, never accept");
  assert.notEqual(result?.ok, true, "a malformed pinned key must never yield ok:true");
});

test("attack 6e: garbage (non-key) bytes as pinned key fails CLOSED (never ok:true)", () => {
  const signed = signSnapshot(freshSnapshot(), PINNED.privateKey);
  const garbage = new Uint8Array(16).fill(0xab); // neither 32 bytes nor valid DER

  let result: { ok: boolean } | undefined;
  let threw = false;
  try {
    result = verifySnapshot(signed, garbage);
  } catch {
    threw = true;
  }
  assert.ok(threw || result?.ok === false);
  assert.notEqual(result?.ok, true, "garbage pinned key must never yield ok:true");
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK 2 (variant) — a structurally-valid signature from a WRONG key over a tampered body:
// tamper is caught first (content_hash_mismatch), so a forger cannot combine tamper + resign
// under an unpinned key to sneak past. Demonstrates the checks compose.
// ─────────────────────────────────────────────────────────────────────────────
test("attack: tamper + resign under attacker key → still content_hash_mismatch vs pinned", () => {
  const attacker = generateKeyPairSync("ed25519");
  const body = freshSnapshot();
  // Attacker properly signs THEIR tampered body (their signature is internally consistent)...
  body.routes["prof_public:/v1/chat/completions"].targets[0].baseUrl = "https://evil.example";
  const forged = signSnapshot(body, attacker.privateKey);
  // ...then presents it, but claims the ORIGINAL untouched body's content hash to dodge the
  // hash check. Recompute over the (evil) body != claimed hash → content_hash_mismatch.
  forged.meta.contentHash = computeContentHash(freshSnapshot());
  const r = verifySnapshot(forged, PINNED.publicKey);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "content_hash_mismatch");
});
