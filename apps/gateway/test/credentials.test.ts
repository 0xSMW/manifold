// Adversarial tests for REAL provider-credential decryption (SPEC §14.3, ADR-0022).
// The gateway decrypts the credential envelope in-proc (unwrap DEK with KEK, open AES-256-GCM),
// injects the plaintext secret ONLY on the upstream request, and FAILS CLOSED on a tampered
// ciphertext (throw → never dispatch, never leak). No env var, no plaintext at rest.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { packBase64, sealAesGcm, unpackBase64, utf8, wrapDek } from "@manifold/crypto";
import { handleRequest, type GatewayContext } from "@manifold/gateway-core";
import type { Snapshot, SnapshotTarget } from "@manifold/ports";
import { FakeCrypto, FakeFetcher, FakeIngestSink, FixedClock, keyedHashHex } from "@manifold/ports/testing";
import { decryptTargetSecret, makeSecretResolver } from "../src/server.ts";

const SECRET = "sk-ant-REAL-PROVIDER-SECRET-should-never-be-plaintext";
const KEK = new Uint8Array(randomBytes(32));
const DEK = new Uint8Array(randomBytes(32));
const ciphertext = packBase64(sealAesGcm(DEK, utf8(SECRET))); // seal secret under DEK
const wrappedDek = packBase64(wrapDek(KEK, DEK)); // wrap DEK under KEK

function target(overrides: Partial<SnapshotTarget> = {}): SnapshotTarget {
  return {
    offeringId: "anthropic.messages", credentialId: "cred1", dekId: "dek1",
    credentialCiphertext: ciphertext, wrappedDek,
    weight: 1, priority: 0, baseUrl: "https://api.anthropic.com", region: null,
    allowedHosts: ["api.anthropic.com"],
    authInject: { headers: { "x-api-key": "${secret}" } },
    secretEnv: null, ...overrides,
  };
}

test("decryptTargetSecret returns the exact secret (real envelope decrypt, no env)", () => {
  assert.equal(decryptTargetSecret(target(), KEK), SECRET);
});

test("wrong KEK cannot decrypt (throws, no wrong-secret)", () => {
  assert.throws(() => decryptTargetSecret(target(), new Uint8Array(randomBytes(32))));
});

test("tampered ciphertext ⇒ resolver rejects (GCM integrity, never a wrong secret)", async () => {
  const raw = unpackBase64(ciphertext);
  raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0x01;
  await assert.rejects(makeSecretResolver(KEK)(target({ credentialCiphertext: packBase64(raw) })));
});

// ── end-to-end via the real handleRequest pipeline ───────────────────────────
const crypto = new FakeCrypto();
const pepper = utf8("test-pepper");
const VALID_KEY = "sk-test-valid-key";
const keyHash = await keyedHashHex(crypto, pepper, VALID_KEY);

function snapshotFor(t: SnapshotTarget): Snapshot {
  return {
    meta: { schema: "manifold.snapshot.v1", installationId: "test", revision: "r1", contentHash: "sha256:x", builtAt: "2026-07-20T00:00:00.000Z", signature: "", signingKeyId: "d" },
    profiles: { localhost: { id: "public_app", mode: "public_app", policyRevision: null, defaultRouteSet: null } },
    keys: { [keyHash]: { id: "vk", profileId: "public_app", scopes: [], allowedAppIds: [], defaultAppId: null, defaultActionId: null, teamId: null, costCenterId: null, budgetAccountId: null, perUserBudget: false, rateLimit: null, expiresAt: null, revoked: false } },
    routes: { "public_app:/v1/messages": { routeId: "rt", revision: "r1", mode: "ordered", targets: [t], retry: { maxAttempts: 1 }, timeoutMs: 5000, capturePolicyId: "c", attributionAppId: null, defaultActionId: null } },
  } as unknown as Snapshot;
}

function countingFetcher(): { fetcher: FakeFetcher; calls: () => number } {
  let n = 0;
  const fetcher = new FakeFetcher(() => { n++; return new Response("ok", { status: 200 }); });
  return { fetcher, calls: () => n };
}

function ctxFor(t: SnapshotTarget, fetcher: FakeFetcher): GatewayContext {
  return {
    installationId: "test", snapshot: snapshotFor(t), crypto,
    clock: new FixedClock(new Date("2026-07-20T00:00:00.000Z")),
    ingest: new FakeIngestSink(), fetcher, pepper,
    resolveSecret: makeSecretResolver(KEK),
    ssrfPolicy: { allowInsecureHttp: false, allowPrivate: true },
  };
}

function req(): Request {
  return new Request("http://localhost/v1/messages", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${VALID_KEY}` }, body: "{}" });
}

test("end-to-end: DECRYPTED secret injected as x-api-key upstream; inbound Authorization NOT forwarded", async () => {
  const { fetcher, calls } = countingFetcher();
  const res = await handleRequest(ctxFor(target(), fetcher), req());
  assert.equal(res.status, 200);
  assert.equal(calls(), 1);
  assert.equal(fetcher.lastHeaders["x-api-key"], SECRET, "gateway must inject the DECRYPTED secret");
  assert.equal(fetcher.lastHeaders["authorization"], undefined, "inbound client key must not leak upstream");
});

test("end-to-end FAIL CLOSED: tampered ciphertext ⇒ 502, upstream NEVER called (no leak)", async () => {
  const raw = unpackBase64(ciphertext);
  raw[5] = (raw[5] ?? 0) ^ 0x01;
  const { fetcher, calls } = countingFetcher();
  const res = await handleRequest(ctxFor(target({ credentialCiphertext: packBase64(raw) }), fetcher), req());
  assert.equal(res.status, 502);
  assert.equal(calls(), 0, "upstream must NOT be called when the credential can't be decrypted");
});

// BUG A (fail-OPEN credential): a target with NO ciphertext/wrappedDek AND an unset secretEnv
// must NOT dispatch an empty-string secret upstream. The resolver has to THROW so handleRequest
// fails CLOSED (502 CREDENTIAL_UNAVAILABLE) — never `Authorization: Bearer <empty>` / x-api-key:''.
test("end-to-end FAIL CLOSED: no credential material at all ⇒ 502, upstream NEVER called (no empty secret dispatched)", async () => {
  delete process.env.MANIFOLD_NONEXISTENT_SECRET; // ensure the env fallback is genuinely absent
  const noCred = target({
    credentialCiphertext: "",
    wrappedDek: "",
    secretEnv: "MANIFOLD_NONEXISTENT_SECRET",
  });
  const { fetcher, calls } = countingFetcher();
  const res = await handleRequest(ctxFor(noCred, fetcher), req());
  assert.equal(res.status, 502, "must fail closed with CREDENTIAL_UNAVAILABLE, not dispatch an empty secret");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "CREDENTIAL_UNAVAILABLE");
  assert.equal(calls(), 0, "upstream must NEVER be called with an empty provider secret");
});

test("makeSecretResolver THROWS when it cannot produce a real non-empty secret", async () => {
  delete process.env.MANIFOLD_NONEXISTENT_SECRET;
  const resolve = makeSecretResolver(KEK);
  await assert.rejects(resolve(target({ credentialCiphertext: "", wrappedDek: "", secretEnv: null })));
  await assert.rejects(
    resolve(target({ credentialCiphertext: "", wrappedDek: "", secretEnv: "MANIFOLD_NONEXISTENT_SECRET" })),
  );
  // An empty-string env value is NOT a real secret either.
  process.env.MANIFOLD_EMPTY_SECRET = "";
  await assert.rejects(
    resolve(target({ credentialCiphertext: "", wrappedDek: "", secretEnv: "MANIFOLD_EMPTY_SECRET" })),
  );
  delete process.env.MANIFOLD_EMPTY_SECRET;
});
