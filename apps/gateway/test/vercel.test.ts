import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { GatewayContext } from "@manifold/gateway-core";
import type { Snapshot, SnapshotTarget } from "@manifold/ports";
import { FakeCrypto, FakeFetcher, FakeIngestSink, FixedClock, keyedHashHex } from "@manifold/ports/testing";
import {
  ORIGINAL_PATH_QUERY_PARAM,
  createVercelGatewayHandler,
  nonCacheableGatewayResponse,
  reconstructGatewayRequest,
} from "../src/vercel.ts";

type VercelConfig = {
  rewrites: Array<{ source: string; destination: string }>;
};

const vercelConfig = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
) as VercelConfig;

const crypto = new FakeCrypto();
const pepper = new TextEncoder().encode("vercel-test-pepper");
const key = "sk-vercel-test";
const keyHash = await keyedHashHex(crypto, pepper, key);

function context(fetcher: GatewayContext["fetcher"]): GatewayContext {
  const target: SnapshotTarget = {
    offeringId: "test.messages",
    credentialId: "credential_test",
    dekId: "dek_test",
    credentialCiphertext: "",
    wrappedDek: "",
    weight: 1,
    priority: 0,
    baseUrl: "https://api.anthropic.com",
    region: null,
    allowedHosts: ["api.anthropic.com"],
    authInject: { headers: { "x-api-key": "${secret}" } },
  };
  const snapshot: Snapshot = {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId: "vercel-test",
      revision: "r1",
      contentHash: "sha256:test",
      builtAt: "2026-07-24T00:00:00.000Z",
      signature: "",
      signingKeyId: "test",
    },
    profiles: {
      "gateway.test": { id: "public", mode: "public_app", policyRevision: null, defaultRouteSet: null },
    },
    keys: {
      [keyHash]: {
        id: "key_test",
        profileId: "public",
        scopes: [],
        allowedAppIds: [],
        budgetAccountId: null,
        expiresAt: null,
      },
    },
    routes: {
      "public:/v1/messages": {
        routeId: "route_messages",
        revision: "r1",
        mode: "ordered",
        timeoutMs: 5_000,
        capturePolicyId: "capture_none",
        targets: [target],
      },
    },
  };
  return {
    installationId: "vercel-test",
    snapshot,
    crypto,
    clock: new FixedClock(),
    ingest: new FakeIngestSink(),
    fetcher,
    pepper,
    resolveSecret: async () => "provider-secret",
  };
}

test("reconstructGatewayRequest restores the /v1 path and preserves user query parameters", () => {
  const request = new Request(
    `https://gateway.test/api/gateway?${ORIGINAL_PATH_QUERY_PARAM}=%2Fv1%2Fmessages&model=a&model=b`,
  );
  const restored = reconstructGatewayRequest(request);

  assert.equal(new URL(restored.url).pathname, "/v1/messages");
  assert.deepEqual(new URL(restored.url).searchParams.getAll("model"), ["a", "b"]);
  assert.equal(new URL(restored.url).searchParams.has(ORIGINAL_PATH_QUERY_PARAM), false);
});

test("Vercel rewrites preserve each supported OpenAI path without a wildcard placeholder", () => {
  const rewrites = new Map(vercelConfig.rewrites.map(({ source, destination }) => [source, destination]));
  const supportedPaths = ["/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/embeddings"];

  for (const path of supportedPaths) {
    assert.equal(
      rewrites.get(path),
      `/api/gateway?${ORIGINAL_PATH_QUERY_PARAM}=${path}`,
      `rewrite must pass the literal original path for ${path}`,
    );
  }

  assert.equal(
    vercelConfig.rewrites.some(({ source, destination }) => source.includes(":path*") || destination.includes(":path*")),
    false,
    "a wildcard rewrite would pass a literal placeholder to the gateway",
  );
  assert.equal(rewrites.get("/health"), "/api/health");
  assert.equal(rewrites.get("/ready"), "/api/ready");
});

test("the Vercel cache-policy wrapper preserves the exact response body stream and other headers", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("body identity"));
      controller.close();
    },
  });
  const coreResponse = new Response(body, {
    status: 201,
    statusText: "Created",
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "content-type": "application/json",
      "x-trace-id": "trace-boundary-123",
    },
  });
  const response = nonCacheableGatewayResponse(coreResponse);

  assert.equal(response.body, body);
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("x-trace-id"), "trace-boundary-123");
  assert.equal(await response.text(), "body identity");
});

test("Vercel handler makes a streaming core response non-cacheable without replacing its body or headers", async () => {
  const upstream = new FakeFetcher(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            controller.enqueue(new TextEncoder().encode("data: second\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream", "x-upstream-trace": "provider-trace-123" } },
      ),
  );
  const background: Promise<unknown>[] = [];
  const handler = createVercelGatewayHandler({
    contextProvider: async () => context(upstream),
    waitUntil: (work) => background.push(work),
  });
  const response = await handler(
    new Request(
      `https://gateway.test/api/gateway?${ORIGINAL_PATH_QUERY_PARAM}=%2Fv1%2Fmessages&stream=true`,
      { method: "POST", headers: { authorization: `Bearer ${key}`, host: "gateway.test" }, body: "{}" },
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-upstream-trace"), "provider-trace-123");
  assert.ok(response.headers.get("x-trace-id"), "gateway trace header is preserved");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
  assert.equal(new URL(upstream.lastRequest!.url).pathname, "/v1/messages");
  assert.equal(new URL(upstream.lastRequest!.url).searchParams.get("stream"), "true");
  assert.equal(new URL(upstream.lastRequest!.url).searchParams.has(ORIGINAL_PATH_QUERY_PARAM), false);
  await Promise.all(background);
  assert.ok(background.length >= 2, "accepted and terminal observations are registered best-effort");
});

test("Vercel handler makes OpenAI-shaped auth failures non-cacheable without losing trace metadata", async () => {
  const handler = createVercelGatewayHandler({
    contextProvider: async () => context(new FakeFetcher(() => {
      throw new Error("invalid bearer must not reach the upstream");
    })),
  });
  const response = await handler(
    new Request(
      `https://gateway.test/api/gateway?${ORIGINAL_PATH_QUERY_PARAM}=%2Fv1%2Fmodels`,
      { headers: { host: "gateway.test" } },
    ),
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-trace-id"), "gateway trace header is preserved");
  assert.deepEqual(await response.json(), {
    error: {
      message: "no api key presented",
      type: "authentication_error",
      param: null,
      code: "AUTH_KEY_UNKNOWN",
    },
  });
});

test("Vercel handler returns a generic error when context initialization fails", async () => {
  const handler = createVercelGatewayHandler({
    contextProvider: async () => {
      throw new Error("database password must not reach the client");
    },
  });
  const response = await handler(new Request("https://gateway.test/api/gateway"));

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: { message: "internal error", type: "api_error", param: null, code: "INTERNAL" },
  });
});
