// Integration tests for the passthrough gateway (SPEC §21 VERIFY). Spends ZERO external tokens:
// a local mock upstream stands in for the provider. Run: `node --test test/*.test.ts`.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import type { GatewayContext } from "@manifold/gateway-core";
import { handleRequest, ssrfCheck, STRICT_SSRF } from "@manifold/gateway-core";
import type { Snapshot, SnapshotTarget } from "@manifold/ports";
import {
  FakeCrypto,
  FakeFetcher,
  FakeIngestSink,
  FixedClock,
  keyedHashHex,
} from "@manifold/ports/testing";
import { startServer } from "../src/server.ts";

// ── shared fixtures ──────────────────────────────────────────────────────────
const crypto = new FakeCrypto();
const pepper = new TextEncoder().encode("test-pepper");
const VALID_KEY = "sk-test-valid-key";
const keyHash = await keyedHashHex(crypto, pepper, VALID_KEY);

function makeTarget(overrides: Partial<SnapshotTarget> = {}): SnapshotTarget {
  return {
    offeringId: "anthropic.messages",
    credentialId: "cred1",
    dekId: "dek1",
    credentialCiphertext: "",
    wrappedDek: "",
    weight: 1,
    priority: 0,
    baseUrl: "https://api.anthropic.com",
    region: null,
    allowedHosts: ["api.anthropic.com"],
    authInject: { headers: { "x-api-key": "${secret}", "anthropic-version": "2023-06-01" } },
    ...overrides,
  };
}

function makeSnapshot(target: SnapshotTarget): Snapshot {
  return {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId: "test",
      revision: "r1",
      contentHash: "sha256:test",
      builtAt: "2026-07-20T00:00:00.000Z",
      signature: "",
      signingKeyId: "d",
    },
    profiles: {
      localhost: { id: "public_app", mode: "public_app", policyRevision: null, defaultRouteSet: null },
    },
    keys: {
      [keyHash]: {
        id: "vk_test",
        profileId: "public_app",
        scopes: [],
        allowedAppIds: [],
        budgetAccountId: null,
        expiresAt: null,
      },
    },
    routes: {
      "public_app:/v1/messages": {
        routeId: "rt_messages",
        revision: "r1",
        mode: "ordered",
        timeoutMs: 5000,
        capturePolicyId: "cap_none",
        targets: [target],
      },
    },
  };
}

interface CtxOpts {
  snapshot: Snapshot;
  fetcher: GatewayContext["fetcher"];
  ssrfPolicy?: GatewayContext["ssrfPolicy"];
  resolveSecret?: GatewayContext["resolveSecret"];
  clock?: GatewayContext["clock"];
}
function makeCtx(o: CtxOpts): { ctx: GatewayContext; ingest: FakeIngestSink } {
  const ingest = new FakeIngestSink();
  const ctx: GatewayContext = {
    installationId: "test",
    snapshot: o.snapshot,
    crypto,
    clock: o.clock ?? new FixedClock(),
    ingest,
    fetcher: o.fetcher,
    pepper,
    resolveSecret: o.resolveSecret ?? (async () => "PROVIDER-SECRET"),
    ssrfPolicy: o.ssrfPolicy,
  };
  return { ctx, ingest };
}

async function waitForTerminal(ingest: FakeIngestSink): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (ingest.events.some((event) => event.kind === "terminal")) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("terminal observation was not delivered");
}

function makeRequest(
  path: string,
  opts: { key?: string; method?: string; body?: string } = {},
): Request {
  const headers = new Headers({ host: "localhost" });
  if (opts.key !== undefined) headers.set("authorization", `Bearer ${opts.key}`);
  const init: RequestInit = { method: opts.method ?? "POST", headers };
  if (opts.body !== undefined) init.body = opts.body;
  return new Request(`http://localhost${path}`, init);
}

// ── (a) valid key streams the mock chunks through ────────────────────────────
test("(a) valid key streams mock SSE chunks through", async () => {
  const mock = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: chunk-one\n\n");
    res.write("data: chunk-two\n\n");
    res.end("data: [DONE]\n\n");
  });
  const port = await listen(mock);
  after(() => mock.close());

  const target = makeTarget({
    baseUrl: `http://127.0.0.1:${port}`,
    allowedHosts: ["127.0.0.1"],
  });
  const { ctx, ingest } = makeCtx({
    snapshot: makeSnapshot(target),
    fetcher: { fetch: (req) => globalThis.fetch(req) },
    ssrfPolicy: { allowInsecureHttp: true, allowPrivate: true },
  });

  const res = await handleRequest(ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  assert.equal(res.status, 200);
  const text = await res.text();
  await waitForTerminal(ingest);
  assert.ok(text.includes("chunk-one"), "streamed chunk-one");
  assert.ok(text.includes("chunk-two"), "streamed chunk-two");
  assert.ok(res.headers.get("x-trace-id"), "X-Trace-Id present");
  // observation emitted after response started
  assert.ok(ingest.events.length >= 1, "observation emitted");
  assert.equal(ingest.events.at(-1)?.status, 200);
});

// ── (b) bad key → 401 AUTH_KEY_UNKNOWN, OpenAI-shaped ────────────────────────
test("(b) bad key → 401 AUTH_KEY_UNKNOWN envelope", async () => {
  const { ctx } = makeCtx({
    snapshot: makeSnapshot(makeTarget()),
    fetcher: { fetch: () => { throw new Error("upstream must not be called"); } },
  });
  const res = await handleRequest(ctx, makeRequest("/v1/messages", { key: "sk-wrong", body: "{}" }));
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: { code: string; type: string } };
  assert.equal(body.error.code, "AUTH_KEY_UNKNOWN");
  assert.equal(body.error.type, "authentication_error");
});

// ── (c) unknown route → ROUTE_UNKNOWN ────────────────────────────────────────
test("(c) unknown route → ROUTE_UNKNOWN", async () => {
  const { ctx } = makeCtx({
    snapshot: makeSnapshot(makeTarget()),
    fetcher: { fetch: () => { throw new Error("upstream must not be called"); } },
  });
  const res = await handleRequest(ctx, makeRequest("/v1/nope", { key: VALID_KEY, body: "{}" }));
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: { code: string; param: string | null } };
  assert.equal(body.error.code, "ROUTE_UNKNOWN");
  assert.equal(body.error.param, "model");
});

// ── (d) SSRF blocked for loopback / RFC-1918 ─────────────────────────────────
test("(d) SSRF blocks loopback and RFC-1918 targets", async () => {
  for (const baseUrl of ["http://127.0.0.1:9", "http://10.0.0.1", "https://192.168.1.10"]) {
    const target = makeTarget({ baseUrl, allowedHosts: [new URL(baseUrl).hostname] });
    const { ctx } = makeCtx({
      snapshot: makeSnapshot(target),
      fetcher: { fetch: () => { throw new Error("upstream must not be called"); } },
      // strict (default) egress policy
    });
    const res = await handleRequest(ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
    assert.equal(res.status, 403, `blocked ${baseUrl}`);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "SSRF_BLOCKED");
  }
  // direct unit assertions on the core checker
  assert.equal(ssrfCheck("http://127.0.0.1/x", ["127.0.0.1"], STRICT_SSRF).ok, false);
  assert.equal(ssrfCheck("https://10.1.2.3/x", ["10.1.2.3"]).ok, false);
  assert.equal(ssrfCheck("https://169.254.1.1/x", ["169.254.1.1"]).ok, false);
  assert.equal(ssrfCheck("http://api.anthropic.com/x", ["api.anthropic.com"]).ok, false); // http
  assert.equal(ssrfCheck("https://evil.example/x", ["api.anthropic.com"]).ok, false); // not allowlisted
  assert.equal(ssrfCheck("https://api.anthropic.com/x", ["api.anthropic.com"]).ok, true);
});

// ── (e) inbound Authorization NOT forwarded; provider auth injected fresh ─────
test("(e) inbound Authorization is stripped; provider auth injected", async () => {
  const fetcher = new FakeFetcher(() => new Response("ok", { status: 200 }));
  const { ctx } = makeCtx({
    snapshot: makeSnapshot(makeTarget()), // baseUrl api.anthropic.com (public, allowlisted)
    fetcher,
    resolveSecret: async () => "SECRET-XYZ",
  });
  const res = await handleRequest(ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  assert.equal(res.status, 200);
  assert.equal(fetcher.lastHeaders["authorization"], undefined, "inbound Authorization not forwarded");
  assert.equal(fetcher.lastHeaders["x-api-key"], "SECRET-XYZ", "provider secret injected fresh");
  assert.equal(fetcher.lastHeaders["anthropic-version"], "2023-06-01");
});

// ── (f) memory stays flat while streaming a large body ───────────────────────
test("(f) streaming a large body keeps memory flat", async () => {
  const TOTAL = 256 * 1024 * 1024; // 256 MB
  const CHUNK = 1024 * 1024; // 1 MB
  let sent = 0;
  const bigStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const remaining = TOTAL - sent;
      if (remaining <= 0) return controller.close();
      const size = Math.min(CHUNK, remaining);
      controller.enqueue(new Uint8Array(size));
      sent += size;
    },
  });

  const fetcher = new FakeFetcher(() => new Response(bigStream, { status: 200 }));
  const { ctx } = makeCtx({ snapshot: makeSnapshot(makeTarget()), fetcher });

  const res = await handleRequest(ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  assert.equal(res.status, 200);

  const startHeap = process.memoryUsage().heapUsed;
  let maxHeap = startHeap;
  let received = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value!.length;
    const h = process.memoryUsage().heapUsed;
    if (h > maxHeap) maxHeap = h;
  }
  assert.equal(received, TOTAL, "entire body streamed through");
  const growthMB = (maxHeap - startHeap) / (1024 * 1024);
  assert.ok(growthMB < 96, `heap growth ${growthMB.toFixed(1)}MB should stay well below 256MB`);
});

// ── (g) end-to-end: real Node server boots, loads snapshot, rejects bad key ───
test("(g) real HTTP server wiring: bad key → 401 through node:http", async () => {
  const srv = await startServer({
    snapshotPath: new URL("../snapshot.example.json", import.meta.url).pathname,
    observationsPath: "/dev/null",
    port: 0,
  });
  after(() => srv.close());

  const res = await fetch(`${srv.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-wrong" },
    body: "{}",
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "AUTH_KEY_UNKNOWN");
});

// ── (h) a successful dispatch emits BOTH accepted AND a terminal event ────────
// Regression: reduce() needs a terminal to close the trace; a 200 that emits only `accepted`
// leaves the trace "incomplete" → $0 cost. Every request must end with a terminal.
test("(h) success path emits accepted + terminal (trace is complete)", async () => {
  const fetcher = new FakeFetcher(() => new Response("ok", { status: 200 }));
  const { ctx, ingest } = makeCtx({ snapshot: makeSnapshot(makeTarget()), fetcher });

  const res = await handleRequest(ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  assert.equal(res.status, 200);
  await waitForTerminal(ingest);

  const kinds = ingest.events.map((e) => e.kind);
  assert.ok(kinds.includes("accepted"), "accepted emitted");
  assert.ok(kinds.includes("terminal"), "terminal emitted");
  const terminal = ingest.events.find((e) => e.kind === "terminal");
  assert.equal(terminal?.status, 200, "terminal carries the final upstream status");
});

// ── (i) occurredAt is stamped per-event, not once at request start ────────────
// Regression: one shared `now` collapses latency/time-windowing. With a clock that advances
// on each read, accepted and terminal must carry distinct occurredAt instants.
test("(i) occurredAt is per-event (accepted ≠ terminal with a ticking clock)", async () => {
  let ms = Date.parse("2026-07-20T00:00:00.000Z");
  const tickingClock = {
    now(): Date {
      const d = new Date(ms);
      ms += 1000; // advance 1s per read
      return d;
    },
  };
  const fetcher = new FakeFetcher(() => new Response("ok", { status: 200 }));
  const { ctx, ingest } = makeCtx({
    snapshot: makeSnapshot(makeTarget()),
    fetcher,
    clock: tickingClock,
  });

  await handleRequest(ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  await waitForTerminal(ingest);
  const accepted = ingest.events.find((e) => e.kind === "accepted");
  const terminal = ingest.events.find((e) => e.kind === "terminal");
  assert.ok(accepted && terminal, "both events emitted");
  assert.notEqual(accepted!.occurredAt, terminal!.occurredAt, "distinct per-event timestamps");
});

// ── (j) undici-shaped timeout → PROVIDER_TIMEOUT 504 (not a generic 502) ──────
// Regression: undici throws TypeError('fetch failed') with the TimeoutError on `.cause`, so a
// top-level `instanceof DOMException` check never matched and timeouts fell through to 5xx.
test("(j) undici timeout (TimeoutError on err.cause) → 504 PROVIDER_TIMEOUT", async () => {
  const fetcher: GatewayContext["fetcher"] = {
    fetch: () => {
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = new DOMException("The operation timed out.", "TimeoutError");
      throw err;
    },
  };
  const { ctx, ingest } = makeCtx({ snapshot: makeSnapshot(makeTarget()), fetcher });

  const res = await handleRequest(ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  assert.equal(res.status, 504);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "PROVIDER_TIMEOUT");
  assert.equal(ingest.events.at(-1)?.reasonCodes[0], "PROVIDER_TIMEOUT");
});

// ── (k) egress SSRF block from the fetcher → 403 SSRF_BLOCKED (not 502) ────────
// Regression: EgressFetcher's post-DNS recheck throws Error('egress: blocked private address …');
// the catch mapped it to PROVIDER_HTTP_5XX 502 instead of the SSRF safety code.
test("(k) egress-blocked fetch error → 403 SSRF_BLOCKED", async () => {
  const fetcher: GatewayContext["fetcher"] = {
    fetch: () => {
      throw new Error("egress: blocked private address 10.0.0.5");
    },
  };
  const { ctx, ingest } = makeCtx({ snapshot: makeSnapshot(makeTarget()), fetcher });

  const res = await handleRequest(ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "SSRF_BLOCKED");
  assert.equal(ingest.events.at(-1)?.reasonCodes[0], "SSRF_BLOCKED");
});

// ── (l) an unparseable expiresAt fails CLOSED → 401 AUTH_KEY_EXPIRED ───────────
// Regression: new Date('not-a-date').getTime() is NaN and `NaN <= now` is false, so a corrupt
// expiry never expired the key (fail-open). It must be treated as expired.
test("(l) corrupt expiresAt ('not-a-date') → 401 AUTH_KEY_EXPIRED", async () => {
  const base = makeSnapshot(makeTarget());
  const snapshot: Snapshot = {
    ...base,
    keys: {
      [keyHash]: { ...base.keys[keyHash]!, expiresAt: "not-a-date" },
    },
  };
  const { ctx } = makeCtx({
    snapshot,
    fetcher: { fetch: () => { throw new Error("upstream must not be called"); } },
  });

  const res = await handleRequest(ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "AUTH_KEY_EXPIRED");
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

// review HIGH #7 (decompression bomb): a response that declares content-encoding must NOT be buffered
// on the strength of its (on-wire, compressed) content-length — undici decompresses on .text() to an
// unbounded size. The guard treats a content-encoded body as a stream: relayed, no usage captured.
test("#7: a content-encoded JSON response is NOT buffered for usage (decompression-bomb guard)", async () => {
  const usageBody = JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } });
  const base = { "content-type": "application/json", "content-length": String(Buffer.byteLength(usageBody)) };

  const gz = new FakeFetcher(() => new Response(usageBody, { status: 200, headers: { ...base, "content-encoding": "gzip" } }));
  const g1 = makeCtx({ snapshot: makeSnapshot(makeTarget()), fetcher: gz });
  await handleRequest(g1.ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  await waitForTerminal(g1.ingest);
  const t1 = g1.ingest.events.find((e) => e.kind === "terminal");
  assert.equal(t1?.usage, undefined, "a content-encoded response must NOT be buffered for usage");

  const plain = new FakeFetcher(() => new Response(usageBody, { status: 200, headers: base }));
  const g2 = makeCtx({ snapshot: makeSnapshot(makeTarget()), fetcher: plain });
  await handleRequest(g2.ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  await waitForTerminal(g2.ingest);
  const t2 = g2.ingest.events.find((e) => e.kind === "terminal");
  assert.equal(t2?.usage?.inputTokens, 10, "the identical PLAIN response IS buffered and usage captured");
});
