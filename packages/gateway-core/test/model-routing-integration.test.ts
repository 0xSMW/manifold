import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest, type GatewayContext } from "../src/handleRequest.ts";
import { LocalCircuitBreaker } from "../src/circuitBreaker.ts";
import type {
  HotPathObservationEvent,
  IngestSink,
  Snapshot,
  SnapshotRoute,
  SnapshotTarget,
} from "@manifold/ports";
import { FakeCrypto, FixedClock, keyedHashHex } from "@manifold/ports/testing";

const installationId = "model-routing-test";
const profileId = "profile_public";
const publicHost = "gateway.example.test";
const apiKey = "sk-model-routing";
const pepper = new TextEncoder().encode("model-routing-pepper");

function target(offeringId: string, baseUrl: string): SnapshotTarget {
  return {
    targetId: `target_${offeringId}`,
    offeringId,
    credentialId: `credential_${offeringId}`,
    dekId: `dek_${offeringId}`,
    credentialCiphertext: "",
    wrappedDek: "",
    weight: 1,
    priority: 0,
    baseUrl,
    region: null,
    allowedHosts: [new URL(baseUrl).hostname],
    authInject: { headers: {} },
  };
}

function route(routeId: string, selectedTarget: SnapshotTarget): SnapshotRoute {
  return {
    routeId,
    revision: `revision_${routeId}`,
    mode: "ordered",
    targets: [selectedTarget],
    timeoutMs: 5_000,
    capturePolicyId: "capture_none",
  };
}

async function contextFor(snapshot: Omit<Snapshot, "keys">): Promise<{
  context: GatewayContext;
  upstreamRequests: Request[];
  observations: HotPathObservationEvent[];
}> {
  const crypto = new FakeCrypto();
  const keyHash = await keyedHashHex(crypto, pepper, apiKey);
  const upstreamRequests: Request[] = [];
  const observations: HotPathObservationEvent[] = [];
  const ingest: IngestSink = {
    emit: async (event) => {
      observations.push(event);
    },
  };
  return {
    context: {
      installationId,
      snapshot: {
        ...snapshot,
        keys: {
          [keyHash]: {
            id: "key_public",
            profileId,
            scopes: [],
            allowedAppIds: [],
            budgetAccountId: null,
            expiresAt: null,
          },
        },
      },
      crypto,
      clock: new FixedClock(),
      ingest,
      fetcher: {
        fetch: async (request) => {
          upstreamRequests.push(request);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "11" },
          });
        },
      },
      pepper,
      resolveSecret: async () => "provider-secret",
    },
    upstreamRequests,
    observations,
  };
}

function baseSnapshot(routes: Record<string, SnapshotRoute>, offerings?: Snapshot["offerings"]): Omit<Snapshot, "keys"> {
  return {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId,
      revision: "revision_1",
      contentHash: "sha256:test",
      builtAt: "2026-07-24T00:00:00.000Z",
      signature: "",
      signingKeyId: "key_1",
    },
    profiles: {
      [publicHost]: { id: profileId, mode: "public_app", policyRevision: null, defaultRouteSet: null },
      "other.example.test": { id: "profile_other", mode: "public_app", policyRevision: null, defaultRouteSet: null },
    },
    routes,
    ...(offerings ? { offerings } : {}),
  };
}

function request(path: string, method: string, body?: Record<string, unknown>): Request {
  return new Request(`https://${publicHost}${path}`, {
    method,
    headers: {
      host: publicHost,
      authorization: `Bearer ${apiKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("two public chat aliases select distinct composite routes", async () => {
  const alphaTarget = target("offering_alpha", "https://alpha.provider.test");
  const betaTarget = target("offering_beta", "https://beta.provider.test");
  const { context, upstreamRequests } = await contextFor(baseSnapshot({
    "profile_public:chat:alpha-public": route("route_alpha", alphaTarget),
    "profile_public:chat:beta-public": route("route_beta", betaTarget),
  }, {
    offering_alpha: { providerModelId: "alpha-provider-model" },
    offering_beta: { providerModelId: "beta-provider-model" },
  }));

  assert.equal((await handleRequest(context, request("/v1/chat/completions", "POST", { model: "alpha-public" }))).status, 200);
  assert.equal((await handleRequest(context, request("/v1/chat/completions", "POST", { model: "beta-public" }))).status, 200);

  assert.equal(upstreamRequests.length, 2);
  assert.equal(new URL(upstreamRequests[0]!.url).hostname, "alpha.provider.test");
  assert.equal(new URL(upstreamRequests[1]!.url).hostname, "beta.provider.test");
  assert.equal((await upstreamRequests[0]!.json() as { model: string }).model, "alpha-provider-model");
  assert.equal((await upstreamRequests[1]!.json() as { model: string }).model, "beta-provider-model");
});

test("unknown-length JSON preserves bytes and records exact terminal usage", async () => {
  const selectedTarget = target("offering_chunked_usage", "https://provider.example.test");
  const { context, observations } = await contextFor(baseSnapshot({
    "profile_public:chat:chunked-usage": route("route_chunked_usage", selectedTarget),
  }, { offering_chunked_usage: { providerModelId: "provider-chunked-usage" } }));
  const body = JSON.stringify({ id: "chunked", usage: { prompt_tokens: 13, completion_tokens: 8 } });
  const bytes = new TextEncoder().encode(body);
  context.fetcher = {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 17));
        controller.enqueue(bytes.slice(17));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/json", "x-upstream-test": "chunked" } }),
  };

  const response = await handleRequest(context, request("/v1/chat/completions", "POST", { model: "chunked-usage" }));
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get("x-upstream-test"), "chunked");
  const terminal = observations.find((event) => event.kind === "terminal");
  assert.deepEqual(terminal?.usage, { inputTokens: 13, outputTokens: 8 });
});

test("oversized unknown-length JSON replays without retaining or billing its body", async () => {
  const selectedTarget = target("offering_chunked_large", "https://provider.example.test");
  const { context, observations } = await contextFor(baseSnapshot({
    "profile_public:chat:chunked-large": route("route_chunked_large", selectedTarget),
  }, { offering_chunked_large: { providerModelId: "provider-chunked-large" } }));
  const body = JSON.stringify({ usage: { prompt_tokens: 13, completion_tokens: 8 }, padding: "x".repeat(270 * 1024) });
  const bytes = new TextEncoder().encode(body);
  const chunks = [bytes.slice(0, 128 * 1024), bytes.slice(128 * 1024, 256 * 1024), bytes.slice(256 * 1024)];
  let index = 0;
  context.fetcher = {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  };

  const response = await handleRequest(context, request("/v1/chat/completions", "POST", { model: "chunked-large" }));
  assert.equal(await response.text(), body);
  const terminal = observations.find((event) => event.kind === "terminal");
  assert.equal(terminal?.usage, undefined);
});

test("selected offering substitutes only the outbound model", async () => {
  const selectedTarget = target("offering_provider", "https://provider.example.test");
  const body = {
    model: "public-alias",
    messages: [{ role: "user", content: "preserve this" }],
    temperature: 0.25,
    response_format: { type: "json_object" },
    vendor_extension: { nested: [1, 2, 3] },
  };
  const { context, upstreamRequests } = await contextFor(baseSnapshot({
    "profile_public:chat:public-alias": route("route_provider", selectedTarget),
  }, {
    offering_provider: { providerModelId: "provider-native-model" },
  }));

  assert.equal((await handleRequest(context, request("/v1/chat/completions", "POST", body))).status, 200);
  assert.equal(upstreamRequests.length, 1);
  assert.deepEqual(await upstreamRequests[0]!.json(), {
    ...body,
    model: "provider-native-model",
  });
});

test("Responses requests retain the Responses endpoint upstream", async () => {
  const selectedTarget = target("offering_responses", "https://responses.provider.test/api/");
  const { context, upstreamRequests } = await contextFor(baseSnapshot({
    "profile_public:responses:responses-public": route("route_responses", selectedTarget),
  }, {
    offering_responses: { providerModelId: "responses-native" },
  }));

  assert.equal((await handleRequest(context, request("/v1/responses", "POST", {
    model: "responses-public",
    input: "hello",
  }))).status, 200);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(new URL(upstreamRequests[0]!.url).pathname, "/api/responses");
  assert.equal((await upstreamRequests[0]!.json() as { model: string }).model, "responses-native");
});

test("provider API roots retain their prefix while root OpenAI bases retain /v1", async () => {
  const geminiTarget = target(
    "offering_gemini",
    "https://generativelanguage.googleapis.com/v1beta/openai/",
  );
  const openAiTarget = target("offering_openai", "https://api.openai.com");
  const { context, upstreamRequests } = await contextFor(baseSnapshot({
    "profile_public:chat:gemini-public": route("route_gemini", geminiTarget),
    "profile_public:chat:openai-public": route("route_openai", openAiTarget),
  }, {
    offering_gemini: { providerModelId: "gemini-native" },
    offering_openai: { providerModelId: "openai-native" },
  }));

  assert.equal((await handleRequest(context, request(
    "/v1/chat/completions?alt=sse&include=usage",
    "POST",
    { model: "gemini-public" },
  ))).status, 200);
  assert.equal((await handleRequest(context, request(
    "/v1/chat/completions?include=usage",
    "POST",
    { model: "openai-public" },
  ))).status, 200);

  assert.equal(upstreamRequests[0]!.url,
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?alt=sse&include=usage");
  assert.equal(upstreamRequests[1]!.url,
    "https://api.openai.com/v1/chat/completions?include=usage");
});

test("GET /v1/models authenticates and lists only active names for its profile", async () => {
  const activeTarget = target("offering_active", "https://models.provider.test");
  const { context, upstreamRequests } = await contextFor(baseSnapshot({
    "profile_public:chat:active-chat": route("route_chat", activeTarget),
    "profile_public:responses:active-response": route("route_responses", activeTarget),
    "profile_other:chat:other-profile-model": route("route_other", activeTarget),
    // Legacy path-keyed entries are intentionally excluded from the model registry.
    "profile_public:/v1/chat/completions": route("legacy", activeTarget),
  }));

  const response = await handleRequest(context, request("/v1/models", "GET"));

  assert.equal(response.status, 200);
  assert.equal(upstreamRequests.length, 0);
  assert.deepEqual((await response.json() as { data: Array<{ id: string }> }).data.map((model) => model.id), [
    "active-chat",
    "active-response",
  ]);
});

test("a signed key rate limit rejects with 429 before provider egress", async () => {
  const selectedTarget = target("offering_limited", "https://limited.provider.test");
  const { context, upstreamRequests } = await contextFor(baseSnapshot({
    "profile_public:chat:limited": route("route_limited", selectedTarget),
  }, {
    offering_limited: { providerModelId: "limited-native" },
  }));
  Object.values(context.snapshot.keys)[0]!.rateLimit = { rpm: 1, tpm: 10 };
  context.rateLimit = () => ({ allowed: false, retryAfterSeconds: 7 });

  const response = await handleRequest(context, request("/v1/chat/completions", "POST", {
    model: "limited",
  }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal(upstreamRequests.length, 0);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "RATE_LIMIT_KEY");
});

test("transient provider failure fails over to the next healthy target", async () => {
  const first = target("offering_first", "https://first.provider.test");
  const second = { ...target("offering_second", "https://second.provider.test"), priority: 1 };
  const retryRoute = {
    ...route("route_retry", first),
    targets: [first, second],
    retryPolicy: { max_attempts: 2, backoff_ms: 0 },
  };
  const setup = await contextFor(baseSnapshot({
    "profile_public:chat:retry-public": retryRoute,
  }, {
    offering_first: { providerModelId: "first-native" },
    offering_second: { providerModelId: "second-native" },
  }));
  let calls = 0;
  setup.context.fetcher = {
    fetch: async (upstream) => {
      setup.upstreamRequests.push(upstream);
      calls += 1;
      return calls === 1 ? new Response("retry", { status: 503 }) : new Response("ok", { status: 200 });
    },
  };

  const response = await handleRequest(setup.context, request("/v1/chat/completions", "POST", {
    model: "retry-public",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(setup.upstreamRequests.map((item) => new URL(item.url).hostname), [
    "first.provider.test",
    "second.provider.test",
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(setup.observations.map((event) => event.kind), [
    "accepted",
    "provider_attempt",
    "provider_attempt",
    "terminal",
  ]);
  assert.deepEqual(setup.observations[1]!.reasonCodes, [
    "PROVIDER_HTTP_5XX",
    "RETRY_ATTEMPT",
    "FAILOVER_ATTEMPT",
  ]);
  assert.equal(setup.observations[1]!.offeringId, "offering_first");
  assert.deepEqual(setup.observations[2]!.reasonCodes, []);
  assert.equal(setup.observations[2]!.offeringId, "offering_second");
});

test("request-size admission rejects before provider egress", async () => {
  const selectedTarget = target("offering_size", "https://size.provider.test");
  const setup = await contextFor(baseSnapshot({
    "profile_public:chat:size-public": route("route_size", selectedTarget),
  }, {
    offering_size: { providerModelId: "size-native" },
  }));
  setup.context.maxRequestBytes = 20;

  const response = await handleRequest(setup.context, request("/v1/chat/completions", "POST", {
    model: "size-public",
    input: "this exceeds the configured request cap",
  }));
  assert.equal(response.status, 413);
  assert.equal(setup.upstreamRequests.length, 0);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "POLICY_BODY_TOO_LARGE");
});

test("concurrency grant remains held until the response stream closes", async () => {
  const selectedTarget = target("offering_concurrency", "https://concurrency.provider.test");
  const setup = await contextFor(baseSnapshot({
    "profile_public:chat:concurrency-public": route("route_concurrency", selectedTarget),
  }, {
    offering_concurrency: { providerModelId: "concurrency-native" },
  }));
  let releases = 0;
  setup.context.acquireConcurrency = () => ({
    allowed: true,
    globalInFlight: 1,
    keyInFlight: 1,
    release: () => {
      releases += 1;
    },
  });
  setup.context.fetcher = {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/octet-stream" } }),
  };

  const response = await handleRequest(setup.context, request("/v1/chat/completions", "POST", {
    model: "concurrency-public",
  }));
  assert.equal(releases, 0);
  assert.equal(await response.text(), "chunk");
  assert.equal(releases, 1);
});

test("an opened target circuit is skipped on the next request", async () => {
  const first = target("offering_circuit_first", "https://circuit-first.provider.test");
  const second = { ...target("offering_circuit_second", "https://circuit-second.provider.test"), priority: 1 };
  const setup = await contextFor(baseSnapshot({
    "profile_public:chat:circuit-public": {
      ...route("route_circuit", first),
      targets: [first, second],
      retryPolicy: { max_attempts: 2, backoff_ms: 0 },
    },
  }, {
    offering_circuit_first: { providerModelId: "circuit-first-native" },
    offering_circuit_second: { providerModelId: "circuit-second-native" },
  }));
  setup.context.circuitBreaker = new LocalCircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 60_000,
  });
  setup.context.fetcher = {
    fetch: async (upstream) => {
      setup.upstreamRequests.push(upstream);
      return new URL(upstream.url).hostname === "circuit-first.provider.test"
        ? new Response("retry", { status: 503 })
        : new Response("ok", { status: 200 });
    },
  };

  assert.equal((await handleRequest(setup.context, request("/v1/chat/completions", "POST", {
    model: "circuit-public",
  }))).status, 200);
  assert.equal((await handleRequest(setup.context, request("/v1/chat/completions", "POST", {
    model: "circuit-public",
  }))).status, 200);
  assert.deepEqual(setup.upstreamRequests.map((upstream) => new URL(upstream.url).hostname), [
    "circuit-first.provider.test",
    "circuit-second.provider.test",
    "circuit-second.provider.test",
  ]);
});
