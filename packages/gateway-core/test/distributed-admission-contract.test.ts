import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest, type GatewayContext } from "@manifold/gateway-core";
import type { HotPathObservationEvent, IngestSink, Snapshot, SnapshotRoute, SnapshotTarget } from "@manifold/ports";
import { FakeCrypto, FixedClock, keyedHashHex } from "@manifold/ports/testing";

const installationId = "distributed-admission-test";
const profileId = "profile_public";
const host = "gateway.example.test";
const apiKey = "sk-distributed-admission";
const pepper = new TextEncoder().encode("distributed-admission-pepper");

function target(): SnapshotTarget {
  return {
    targetId: "target_primary",
    offeringId: "offering_primary",
    credentialId: "credential_primary",
    dekId: "dek_primary",
    credentialCiphertext: "",
    wrappedDek: "",
    weight: 1,
    priority: 0,
    baseUrl: "https://provider.example.test",
    region: null,
    allowedHosts: ["provider.example.test"],
    authInject: { headers: {} },
  };
}

function snapshot(): Omit<Snapshot, "keys"> {
  const selected = target();
  const route: SnapshotRoute = {
    routeId: "route_primary",
    revision: "revision_primary",
    mode: "ordered",
    targets: [selected],
    timeoutMs: 5_000,
    capturePolicyId: "capture_none",
  };
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
      [host]: { id: profileId, mode: "public_app", policyRevision: null, defaultRouteSet: null },
    },
    routes: { "profile_public:chat:public-model": route },
    offerings: { offering_primary: { providerModelId: "provider-model" } },
  };
}

async function setup(): Promise<{ context: GatewayContext; upstream: Request[] }> {
  const crypto = new FakeCrypto();
  const keyHash = await keyedHashHex(crypto, pepper, apiKey);
  const upstream: Request[] = [];
  const ingest: IngestSink = { emit: async (_event: HotPathObservationEvent) => {} };
  return {
    context: {
      installationId,
      snapshot: {
        ...snapshot(),
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
          upstream.push(request);
          return new Response("ok", { status: 200 });
        },
      },
      pepper,
      resolveSecret: async () => "provider-secret",
    },
    upstream,
  };
}

function chatRequest(): Request {
  return new Request(`https://${host}/v1/chat/completions`, {
    method: "POST",
    headers: {
      host,
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "public-model", messages: [{ role: "user", content: "hello" }] }),
  });
}

test("distributed authority failures fail closed before provider egress", async () => {
  const { context, upstream } = await setup();
  context.distributedAdmission = async () => {
    throw new Error("authority unavailable");
  };

  const response = await handleRequest(context, chatRequest());

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal((await response.json() as { error: { code: string } }).error.code, "RATE_LIMIT_KEY");
  assert.equal(upstream.length, 0);
});

test("distributed denial fails closed with its retry hint before provider egress", async () => {
  const { context, upstream } = await setup();
  context.distributedAdmission = async () => ({
    allowed: false,
    reason: "tpm",
    retryAfterSeconds: 9,
  });

  const response = await handleRequest(context, chatRequest());

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "9");
  assert.equal(upstream.length, 0);
});

test("strict distributed admission bypasses both local limiters and receives bounded decode metadata", async () => {
  const { context } = await setup();
  const key = Object.values(context.snapshot.keys)[0]!;
  key.rateLimit = { rpm: 11, tpm: 22, burst: 3 };
  context.acquireConcurrency = () => {
    throw new Error("local concurrency must be bypassed");
  };
  context.rateLimit = () => {
    throw new Error("local rate limit must be bypassed");
  };
  let received: Parameters<NonNullable<GatewayContext["distributedAdmission"]>>[0] | undefined;
  context.distributedAdmission = async (input) => {
    received = input;
    return { allowed: true, async release() {} };
  };

  const response = await handleRequest(context, chatRequest());

  assert.equal(response.status, 200);
  assert.equal(received?.installationId, installationId);
  assert.equal(received?.virtualKeyId, "key_public");
  assert.ok((received?.estimatedTokens ?? 0) > 0);
  assert.deepEqual(received?.rateLimit, { rpm: 11, tpm: 22, burst: 3 });
});

test("distributed admission covers zero-token /v1/models requests", async () => {
  const { context, upstream } = await setup();
  let receivedTokens = -1;
  let releases = 0;
  context.distributedAdmission = async (input) => {
    receivedTokens = input.estimatedTokens;
    return { allowed: true, async release() { releases += 1; } };
  };
  const request = new Request(`https://${host}/v1/models`, {
    headers: { host, authorization: `Bearer ${apiKey}` },
  });

  const response = await handleRequest(context, request);

  assert.equal(response.status, 200);
  await response.text();
  assert.equal(receivedTokens, 0);
  assert.equal(releases, 1);
  assert.equal(upstream.length, 0);
});

async function assertReleaseOnce(
  upstreamResponse: Response,
  settle: (response: Response) => Promise<void>,
): Promise<void> {
  const { context } = await setup();
  let releases = 0;
  context.distributedAdmission = async () => ({
    allowed: true,
    async release() { releases += 1; },
  });
  context.fetcher = { fetch: async () => upstreamResponse };

  const response = await handleRequest(context, chatRequest());
  await settle(response);
  assert.equal(releases, 1);
}

test("distributed grant releases exactly once on body completion", async () => {
  await assertReleaseOnce(
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ok"));
        controller.close();
      },
    })),
    async (response) => { await response.text(); },
  );
});

test("distributed grant releases exactly once on downstream cancellation", async () => {
  await assertReleaseOnce(
    new Response(new ReadableStream<Uint8Array>({
      pull() {},
    })),
    async (response) => { await response.body!.cancel("client cancelled"); },
  );
});

test("distributed grant releases exactly once on body error", async () => {
  await assertReleaseOnce(
    new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("upstream body failed")); },
    })),
    async (response) => { await assert.rejects(response.text()); },
  );
});

test("distributed grant releases before a no-body response is returned", async () => {
  await assertReleaseOnce(new Response(null, { status: 204 }), async () => {});
});

test("distributed grant signal is combined into provider fetch cancellation", async () => {
  const { context } = await setup();
  const controller = new AbortController();
  controller.abort("authority revoked grant");
  let providerSignal: AbortSignal | undefined;
  context.distributedAdmission = async () => ({
    allowed: true,
    signal: controller.signal,
    async release() {},
  });
  context.fetcher = {
    fetch: async (request) => {
      providerSignal = request.signal;
      return new Response("ok", { status: 200 });
    },
  };

  const response = await handleRequest(context, chatRequest());

  assert.equal(response.status, 200);
  assert.ok(providerSignal);
  assert.equal(providerSignal.aborted, true);
});
