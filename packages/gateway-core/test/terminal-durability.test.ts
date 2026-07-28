import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest, relayObservedStream, type GatewayContext } from "../src/handleRequest.ts";
import type { SseUsageTransform } from "../src/sseUsage.ts";
import type { HotPathObservationEvent, IngestSink, Snapshot, SnapshotTarget } from "@manifold/ports";
import { FakeCrypto, FixedClock, keyedHashHex } from "@manifold/ports/testing";

const crypto = new FakeCrypto();
const pepper = new TextEncoder().encode("terminal-durability-pepper");
const key = "sk-terminal-durability";
const keyHash = await keyedHashHex(crypto, pepper, key);

function target(): SnapshotTarget {
  return {
    targetId: "target_terminal",
    offeringId: "test.offering",
    credentialId: "credential",
    dekId: "dek",
    credentialCiphertext: "",
    wrappedDek: "",
    weight: 1,
    priority: 0,
    baseUrl: "https://api.example.com",
    region: null,
    allowedHosts: ["api.example.com"],
    authInject: { headers: {} },
  };
}

function snapshot(hardBudget: boolean): Snapshot {
  return {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId: "test",
      revision: "r1",
      contentHash: "sha256:test",
      builtAt: "2026-07-24T00:00:00.000Z",
      signature: "",
      signingKeyId: "key",
    },
    profiles: {
      localhost: { id: "profile", mode: "public_app", policyRevision: null, defaultRouteSet: null },
    },
    keys: {
      [keyHash]: {
        id: "virtual-key",
        profileId: "profile",
        scopes: [],
        allowedAppIds: [],
        budgetAccountId: hardBudget ? "budget" : null,
        expiresAt: null,
      },
    },
    routes: {
      "profile:/v1/messages": {
        routeId: "route",
        revision: "r1",
        mode: "ordered",
        targets: [target()],
        timeoutMs: 5_000,
        capturePolicyId: "none",
      },
    },
    ...(hardBudget ? {
      budgets: { budget: { id: "budget", enforcement: "hard", unit: "tokens" } },
      offerings: {
        "test.offering": {
          price: { inputPerMtokMicroUsd: "1000000", outputPerMtokMicroUsd: "2000000" },
          priceRevisionId: "price_1",
        },
      },
    } : {}),
  };
}

function context(ingest: IngestSink, hardBudget: boolean): GatewayContext {
  return {
    installationId: "test",
    snapshot: snapshot(hardBudget),
    crypto,
    clock: new FixedClock(),
    ingest,
    fetcher: { fetch: async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }) },
    pepper,
    resolveSecret: async () => "secret",
    ...(hardBudget ? { reserveBudget: async () => ({ ok: true as const, reservationId: "reservation" }) } : {}),
  };
}

function request(): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { host: "localhost", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "test", max_tokens: 10 }),
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

test("serializes accepted before terminal when ingest is delayed", async () => {
  const acceptedGate = deferred();
  const emitted: HotPathObservationEvent[] = [];
  const ingest: IngestSink = {
    async emit(event) {
      emitted.push(event);
      if (event.kind === "accepted") await acceptedGate.promise;
    },
  };

  const response = handleRequest(context(ingest, true), request());
  await waitFor(() => emitted.length === 1);
  assert.deepEqual(emitted.map((event) => event.kind), ["accepted"]);

  acceptedGate.resolve();
  assert.equal((await response).status, 200);
  assert.deepEqual(emitted.map((event) => event.kind), [
    "accepted",
    "provider_attempt",
    "terminal",
  ]);
});

test("hard-budget success waits for terminal persistence", async () => {
  const terminalGate = deferred();
  let terminalStarted = false;
  const ingest: IngestSink = {
    async emit(event) {
      if (event.kind === "terminal") {
        terminalStarted = true;
        await terminalGate.promise;
      }
    },
  };

  let settled = false;
  const response = handleRequest(context(ingest, true), request()).then((value) => {
    settled = true;
    return value;
  });
  await waitFor(() => terminalStarted);
  assert.equal(terminalStarted, true);
  assert.equal(settled, false);

  terminalGate.resolve();
  assert.equal((await response).status, 200);
});

test("hard-budget terminal failure rejects rather than returning a successful response", async () => {
  const ingest: IngestSink = {
    async emit(event) {
      if (event.kind === "terminal") throw new Error("ingest unavailable");
    },
  };

  await assert.rejects(handleRequest(context(ingest, true), request()), /ingest unavailable/);
});

test("public provider terminal failure also fails closed", async () => {
  const ingest: IngestSink = {
    async emit(event) {
      if (event.kind === "terminal") throw new Error("outbox unavailable");
    },
  };

  await assert.rejects(handleRequest(context(ingest, false), request()), /outbox unavailable/);
});

test("public provider success waits for terminal outbox persistence", async () => {
  const terminalGate = deferred();
  let terminalStarted = false;
  const emitted: HotPathObservationEvent[] = [];
  const ingest: IngestSink = {
    async emit(event) {
      emitted.push(event);
      if (event.kind === "terminal") {
        terminalStarted = true;
        await terminalGate.promise;
      }
    },
  };

  let settled = false;
  const response = handleRequest(context(ingest, false), request()).then((value) => {
    settled = true;
    return value;
  });
  await waitFor(() => terminalStarted);
  assert.equal(terminalStarted, true);
  assert.equal(settled, false);
  terminalGate.resolve();
  assert.equal((await response).status, 200);
  assert.equal(emitted.at(-1)?.usage, undefined);
  assert.equal(emitted.at(-1)?.costFidelity, undefined);
});

test("hard-budget SSE withholds the completion frame until terminal persistence", async () => {
  const terminalGate = deferred();
  let terminalStarted = false;
  const emitted: HotPathObservationEvent[] = [];
  const ingest: IngestSink = {
    async emit(event) {
      emitted.push(event);
      if (event.kind === "terminal") {
        terminalStarted = true;
        await terminalGate.promise;
      }
    },
  };
  const ctx = context(ingest, true);
  const encoder = new TextEncoder();
  ctx.fetcher = {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"usage":{"input_tokens":3,"output_tokens":5}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  };

  const response = await handleRequest(ctx, request());
  const reader = response.body!.getReader();
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    'data: {"usage":{"input_tokens":3,"output_tokens":5}}\n\n',
  );

  let completionSettled = false;
  const completion = reader.read().then((value) => {
    completionSettled = true;
    return value;
  });
  await waitFor(() => terminalStarted);
  assert.equal(completionSettled, false);

  terminalGate.resolve();
  assert.equal(new TextDecoder().decode((await completion).value), "data: [DONE]\n\n");
  assert.deepEqual(emitted.map((event) => event.kind), [
    "accepted",
    "provider_attempt",
    "terminal",
  ]);
  assert.deepEqual(emitted.at(-1)?.usage, { inputTokens: 3, outputTokens: 5 });
  assert.equal(emitted.at(-1)?.costFidelity, undefined);
});

test("hard-budget non-stream success without provider usage commits its conservative reservation estimate", async () => {
  const emitted: HotPathObservationEvent[] = [];
  const ingest: IngestSink = { async emit(event) { emitted.push(event); } };
  const response = await handleRequest(context(ingest, true), request());
  assert.equal(response.status, 200);
  const terminal = emitted.at(-1)!;
  assert.equal(terminal.kind, "terminal");
  assert.deepEqual(terminal.usage, { inputTokens: 8, outputTokens: 10 });
  assert.deepEqual(terminal.price, { inputPerMtokMicroUsd: "1000000", outputPerMtokMicroUsd: "2000000" });
  assert.equal(terminal.priceRevisionId, "price_1");
  assert.equal(terminal.costFidelity, "estimated");
  assert.equal(terminal.reservationId, "reservation");
});

test("an ambiguous billable failure does not fail over to a second offering", async () => {
  const emitted: HotPathObservationEvent[] = [];
  const ingest: IngestSink = { async emit(event) { emitted.push(event); } };
  const ctx = context(ingest, true);
  const expensive = target();
  const cheap: SnapshotTarget = {
    ...target(),
    targetId: "target_terminal_cheap",
    offeringId: "test.offering.cheap",
    credentialId: "credential_cheap",
    priority: 1,
  };
  ctx.snapshot = {
    ...ctx.snapshot,
    offerings: {
      "test.offering": {
        price: { inputPerMtokMicroUsd: "3000000", outputPerMtokMicroUsd: "6000000" },
        priceRevisionId: "price_expensive",
      },
      "test.offering.cheap": {
        price: { inputPerMtokMicroUsd: "1000000", outputPerMtokMicroUsd: "2000000" },
        priceRevisionId: "price_cheap",
      },
    },
    routes: {
      "profile:/v1/messages": {
        ...ctx.snapshot.routes["profile:/v1/messages"]!,
        targets: [expensive, cheap],
        retryPolicy: { maxAttempts: 2, baseBackoffMs: 0 },
      },
    },
  };
  let attempts = 0;
  ctx.fetcher = {
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("retry", { status: 500 })
        : new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    },
  };

  const response = await handleRequest(ctx, request());
  assert.equal(response.status, 500);
  assert.equal(attempts, 1);
  const terminal = emitted.at(-1)!;
  assert.equal(terminal.offeringId, "test.offering");
  assert.equal(terminal.status, 500);
  assert.deepEqual(terminal.reasonCodes, ["PROVIDER_HTTP_5XX"]);
});

test("hard-budget incomplete SSE without usage commits its conservative reservation estimate", async () => {
  const emitted: HotPathObservationEvent[] = [];
  const ingest: IngestSink = { async emit(event) { emitted.push(event); } };
  const ctx = context(ingest, true);
  const encoder = new TextEncoder();
  ctx.fetcher = {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"delta":"partial"}\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  };

  const response = await handleRequest(ctx, request());
  await response.text();
  await microtasks();
  const terminal = emitted.at(-1)!;
  assert.equal(terminal.kind, "terminal");
  assert.equal(terminal.status, 502);
  assert.deepEqual(terminal.reasonCodes, ["PROVIDER_STREAM_ABORTED"]);
  assert.deepEqual(terminal.usage, { inputTokens: 8, outputTokens: 10 });
  assert.equal(terminal.costFidelity, "estimated");
  assert.equal(terminal.reservationId, "reservation");
});

test("Responses failed and incomplete terminals are not recorded as stream aborts", async () => {
  const encoder = new TextEncoder();
  for (const eventType of ["response.failed", "response.incomplete"]) {
    const emitted: HotPathObservationEvent[] = [];
    const ingest: IngestSink = { async emit(event) { emitted.push(event); } };
    const ctx = context(ingest, true);
    ctx.fetcher = {
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: ${eventType}\ndata: {\"type\":\"${eventType}\"}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    };

    const response = await handleRequest(ctx, request());
    await response.text();
    await microtasks();
    const terminal = emitted.at(-1)!;
    assert.equal(terminal.kind, "terminal");
    assert.equal(terminal.status, 200, eventType);
    assert.deepEqual(
      terminal.reasonCodes,
      [eventType === "response.failed" ? "PROVIDER_RESPONSE_FAILED" : "PROVIDER_RESPONSE_INCOMPLETE"],
      eventType,
    );
  }
});

test("awaits terminal accounting when the stream reader cancellation rejects", async () => {
  const cancellationError = new Error("provider reader cancellation failed");
  const accountingError = new Error("terminal accounting failed");
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  let rejectAccounting!: (reason: unknown) => void;
  const observer = {
    stream,
    result: new Promise<void>((_resolve, reject) => { rejectAccounting = reject; }),
    abort() {},
  } as SseUsageTransform;
  // The relay's reader is deliberately mocked at this boundary: native
  // pipeThrough cancellation can normalize source cancellation failures into
  // transformer failures before this function sees them.
  const source = {
    pipeThrough() {
      return {
        getReader() {
          return {
            read: async () => ({ done: true, value: undefined }),
            cancel: async () => {
              rejectAccounting(accountingError);
              throw cancellationError;
            },
          };
        },
      };
    },
  };
  const response = relayObservedStream(source as unknown as ReadableStream<Uint8Array>, observer);
  const reader = response.getReader();
  await assert.rejects(
    reader.cancel("client stopped reading"),
    (error: unknown) => error instanceof AggregateError &&
      error.errors.includes(cancellationError) && error.errors.includes(accountingError),
  );
});
