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
    secretEnv: null,
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
        revoked: false,
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
}
function makeCtx(o: CtxOpts): { ctx: GatewayContext; ingest: FakeIngestSink } {
  const ingest = new FakeIngestSink();
  const ctx: GatewayContext = {
    installationId: "test",
    snapshot: o.snapshot,
    crypto,
    clock: new FixedClock(),
    ingest,
    fetcher: o.fetcher,
    pepper,
    resolveSecret: o.resolveSecret ?? (async () => "PROVIDER-SECRET"),
    ssrfPolicy: o.ssrfPolicy,
  };
  return { ctx, ingest };
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
    secretEnv: null,
  });
  const { ctx, ingest } = makeCtx({
    snapshot: makeSnapshot(target),
    fetcher: { fetch: (req) => globalThis.fetch(req) },
    ssrfPolicy: { allowInsecureHttp: true, allowPrivate: true },
  });

  const res = await handleRequest(ctx, makeRequest("/v1/messages", { key: VALID_KEY, body: "{}" }));
  assert.equal(res.status, 200);
  const text = await res.text();
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

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}
