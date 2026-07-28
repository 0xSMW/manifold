import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSigningKeyPair, signSnapshot } from "@manifold/config";
import { generateKeyPairSync } from "node:crypto";
import type { Snapshot } from "@manifold/ports";
import { RemoteSnapshotStore } from "../src/remoteSnapshot.ts";

const keys = generateSigningKeyPair();
const installationIdentity = generateKeyPairSync("ed25519");
const installationPrivateKeyBase64 = installationIdentity.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
let sequence = 0;

function signedSnapshot(installationId: string, builtAt = "2026-07-24T00:00:00.000Z"): Snapshot {
  sequence += 1;
  const snapshot = {
    meta: { schema: "manifold.snapshot.v1", installationId, revision: `rev_${sequence}`, contentHash: "", builtAt, signature: "", signingKeyId: "" },
    profiles: {}, keys: {}, routes: {}, offerings: {}, policies: {},
  } as unknown as Snapshot;
  return signSnapshot(snapshot as never, keys.privateKeyBase64, keys.signingKeyId) as unknown as Snapshot;
}

function signedSnapshotWith(
  installationId: string,
  signing: ReturnType<typeof generateSigningKeyPair>,
): Snapshot {
  sequence += 1;
  return signSnapshot({
    meta: { schema: "manifold.snapshot.v1", installationId, revision: `rev_${sequence}`, contentHash: "", builtAt: "2026-07-24T00:00:00.000Z", signature: "", signingKeyId: "" },
    profiles: {}, keys: {}, routes: {}, offerings: {}, policies: {},
  } as never, signing.privateKeyBase64, signing.signingKeyId) as unknown as Snapshot;
}

function clock(start = 1_000) {
  let current = start;
  return { value: () => current, advance: (ms: number) => { current += ms; }, port: { now: () => new Date(current) } };
}

function response(snapshot: unknown): Response { return new Response(JSON.stringify(snapshot), { status: 200 }); }

function store(id: string, fetchFn: typeof fetch, now: ReturnType<typeof clock>, options: Partial<ConstructorParameters<typeof RemoteSnapshotStore>[0]> = {}) {
  return new RemoteSnapshotStore({ controlPlaneBaseUrl: `https://${id}.control.example`, installationPrivateKeyBase64, publicKeyBase64: keys.publicKeyBase64, fetch: fetchFn, clock: now.port, ...options });
}

test("cold load fetches, authenticates, and verifies the control-plane snapshot", async () => {
  const id = "cold-load"; const now = clock(); const snap = signedSnapshot(id); let calls = 0;
  const got = await store(id, (async (url, init) => { calls++; assert.match(String(url), /\/api\/v1\/config\/active\?installationId=cold-load/); const headers = new Headers(init?.headers); assert.equal(headers.get("authorization"), null); assert.equal(headers.get("x-manifold-installation-id"), id); assert.ok(headers.get("x-manifold-signature")); return response(snap); }) as typeof fetch, now).loadActive(id);
  assert.equal(got.meta.contentHash, snap.meta.contentHash); assert.equal(calls, 1);
});

test("concurrent stale loads coalesce into one refresh", async () => {
  const id = "coalesce"; const now = clock(); const snap = signedSnapshot(id); let calls = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const s = store(id, (async () => { calls++; await gate; return response(snap); }) as typeof fetch, now);
  const first = s.loadActive(id); const second = s.loadActive(id); await Promise.resolve(); assert.equal(calls, 1); release();
  assert.equal((await first).meta.contentHash, (await second).meta.contentHash);
});

test("fresh cache hit avoids a second remote fetch and stale entry refreshes", async () => {
  const id = "cache-refresh"; const now = clock(); const first = signedSnapshot(id, "2026-07-24T00:00:00.000Z"); const next = signedSnapshot(id, "2026-07-24T00:00:01.000Z"); let calls = 0;
  const s = store(id, (async () => response(++calls === 1 ? first : next)) as typeof fetch, now, { freshnessTtlMs: 5 });
  assert.equal((await s.loadActive(id)).meta.revision, first.meta.revision); assert.equal((await s.loadActive(id)).meta.revision, first.meta.revision); assert.equal(calls, 1);
  now.advance(6); assert.equal((await s.loadActive(id)).meta.revision, next.meta.revision); assert.equal(calls, 2);
});

test("readiness timestamps a fresh verification even when the published snapshot is unchanged", async () => {
  const id = "readiness-refetch";
  const now = clock(Date.parse("2026-07-24T12:00:00.000Z"));
  const unchangedPublication = signedSnapshot(id, "2026-07-01T00:00:00.000Z");
  const s = store(id, (async () => response(unchangedPublication)) as typeof fetch, now, {
    freshnessTtlMs: 0,
    maxStaleMs: 60_000,
  });

  const first = await s.checkReady(id);
  now.advance(1_000);
  const refetched = await s.checkReady(id);

  assert.equal(first.snapshot.meta.revision, unchangedPublication.meta.revision);
  assert.equal(refetched.snapshot.meta.revision, unchangedPublication.meta.revision);
  assert.equal(refetched.verifiedAtMs, now.value());
  assert.equal(refetched.snapshot.meta.builtAt, "2026-07-01T00:00:00.000Z");
});

test("bad signature and installation mismatch retain an acceptable last-known-good snapshot", async () => {
  const id = "bad-and-mismatch"; const now = clock(); const good = signedSnapshot(id); const bad = structuredClone(good); bad.meta.signature = "not-a-signature";
  const wrongInstallation = signedSnapshot("another-installation"); let call = 0;
  const s = store(id, (async () => response([good, bad, wrongInstallation][call++]!)) as typeof fetch, now, { freshnessTtlMs: 0, maxStaleMs: 100 });
  assert.equal((await s.loadActive(id)).meta.contentHash, good.meta.contentHash); now.advance(1);
  assert.equal((await s.loadActive(id)).meta.contentHash, good.meta.contentHash); now.advance(1);
  assert.equal((await s.loadActive(id)).meta.contentHash, good.meta.contentHash);
});

test("keyring overlap accepts old and new signers, and an unknown ID retains verified LKG", async () => {
  const id = "keyring-overlap"; const now = clock();
  const old = generateSigningKeyPair(); const next = generateSigningKeyPair();
  const oldSnapshot = signedSnapshotWith(id, old); const newSnapshot = signedSnapshotWith(id, next);
  const unknown = structuredClone(newSnapshot); unknown.meta.signingKeyId = "key_unlisted";
  let call = 0;
  const s = store(id, (async () => response([oldSnapshot, newSnapshot, unknown][call++]!)) as typeof fetch, now, {
    publicKeys: { [old.signingKeyId]: old.publicKeyBase64, [next.signingKeyId]: next.publicKeyBase64 },
    freshnessTtlMs: 0,
    maxStaleMs: 100,
  });
  assert.equal((await s.loadActive(id)).meta.revision, oldSnapshot.meta.revision);
  now.advance(1);
  assert.equal((await s.loadActive(id)).meta.revision, newSnapshot.meta.revision);
  now.advance(1);
  assert.equal((await s.loadActive(id)).meta.revision, newSnapshot.meta.revision, "unknown signer must not replace LKG");
});

test("key retirement rejects the old signer and does not share LKG across different trust keyrings", async () => {
  const id = "keyring-retirement"; const now = clock();
  const old = generateSigningKeyPair(); const next = generateSigningKeyPair();
  const oldSnapshot = signedSnapshotWith(id, old); const nextSnapshot = signedSnapshotWith(id, next);
  const overlap = store(id, (async () => response(oldSnapshot)) as typeof fetch, now, {
    publicKeys: { [old.signingKeyId]: old.publicKeyBase64, [next.signingKeyId]: next.publicKeyBase64 },
  });
  await overlap.loadActive(id);

  let calls = 0;
  const retired = store(id, (async () => response(++calls === 1 ? oldSnapshot : nextSnapshot)) as typeof fetch, now, {
    publicKeys: { [next.signingKeyId]: next.publicKeyBase64 },
    freshnessTtlMs: 0,
  });
  await assert.rejects(retired.loadActive(id), /no verified remote snapshot/);
  assert.equal((await retired.loadActive(id)).meta.revision, nextSnapshot.meta.revision);
});

test("oversized responses are rejected without replacing last-known-good", async () => {
  const id = "oversized"; const now = clock(); const good = signedSnapshot(id); let call = 0;
  const s = store(id, (async () => {
    if (++call === 1) return response(good);
    return new Response("{}", { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } });
  }) as typeof fetch, now, { freshnessTtlMs: 0, maxStaleMs: 100 });
  await s.loadActive(id); now.advance(1);
  assert.equal((await s.loadActive(id)).meta.contentHash, good.meta.contentHash);
});

test("fetch timeout/failure use LKG only while it is within max stale, then fail closed", async () => {
  const id = "timeout-stale"; const now = clock(); const good = signedSnapshot(id); let call = 0;
  const failingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (++call === 1) return response(good);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }) as typeof fetch;
  const s = store(id, failingFetch, now, { freshnessTtlMs: 0, maxStaleMs: 10, timeoutMs: 1 });
  await s.loadActive(id); now.advance(5); assert.equal((await s.loadActive(id)).meta.contentHash, good.meta.contentHash);
  now.advance(6); await assert.rejects(s.loadActive(id), /no verified remote snapshot/);
  await assert.rejects(store("fetch-no-lkg", (async () => { throw new Error("network"); }) as typeof fetch, now).loadActive("fetch-no-lkg"), /no verified remote snapshot/);
});

test("readiness fails closed once a fetch failure outlives the configured LKG limit", async () => {
  const id = "readiness-stale"; const now = clock(); const good = signedSnapshot(id); let calls = 0;
  const s = store(id, (async () => {
    if (++calls === 1) return response(good);
    throw new Error("network");
  }) as typeof fetch, now, { freshnessTtlMs: 0, maxStaleMs: 10 });
  await s.checkReady(id);
  now.advance(10);
  assert.equal((await s.checkReady(id)).snapshot.meta.revision, good.meta.revision);
  now.advance(1);
  await assert.rejects(s.checkReady(id), /no verified remote snapshot/);
});

test("accelerator never receives installation credentials and an active rollback may be older", async () => {
  const id = "accelerator-token"; const now = clock();
  const current = signedSnapshot(id, "2026-07-24T00:00:10.000Z");
  const rollback = signedSnapshot(id, "2026-07-23T00:00:00.000Z");
  const seen: Array<{ url: string; authorization: string | null }> = [];
  let controlCalls = 0;
  const fetchFn = (async (input, init) => {
    const url = String(input);
    seen.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url.startsWith("https://edge.example")) return new Response("unavailable", { status: 503 });
    return response(++controlCalls === 1 ? current : rollback);
  }) as typeof fetch;
  const s = store(id, fetchFn, now, {
    acceleratorUrl: "https://edge.example/snapshot",
    freshnessTtlMs: 0,
  });

  assert.equal((await s.loadActive(id)).meta.revision, current.meta.revision);
  now.advance(1);
  assert.equal((await s.loadActive(id)).meta.revision, rollback.meta.revision);
  assert.equal(seen[0]?.authorization, null);
  assert.equal(seen[1]?.authorization, null);
});

test("heartbeat reports the adopted revision with installation authentication", async () => {
  const id = "heartbeat";
  const now = clock(Date.parse("2026-07-24T12:00:00.000Z"));
  let request: { url: string; init?: RequestInit } | undefined;
  const s = store(id, (async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch, now);

  await s.reportHeartbeat(id, "revision-42");

  assert.equal(request?.url, `https://${id}.control.example/api/v1/installations/${id}/heartbeat`);
  assert.equal(request?.init?.method, "POST");
  const headers = new Headers(request?.init?.headers);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("x-manifold-installation-id"), id);
  assert.equal(headers.get("x-manifold-timestamp"), "2026-07-24T12:00:00.000Z");
  assert.ok(headers.get("x-manifold-nonce"));
  assert.ok(headers.get("x-manifold-signature"));
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    appliedConfigRevision: "revision-42",
    reportedAt: "2026-07-24T12:00:00.000Z",
  });
});

test("heartbeat fails closed when the control plane rejects it", async () => {
  const id = "heartbeat-rejected";
  const now = clock();
  const s = store(id, (async () => new Response("rejected", { status: 401 })) as typeof fetch, now);
  await assert.rejects(s.reportHeartbeat(id, "revision-1"), /heartbeat was rejected/);
});
