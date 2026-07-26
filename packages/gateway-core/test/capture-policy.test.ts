import assert from "node:assert/strict";
import test from "node:test";
import { ObservationIngestContracts } from "../../contracts/src/index.ts";
import { boundedObservationCapture } from "../dist/handleRequest.js";

function terminalWithCapture(capture: NonNullable<ReturnType<typeof boundedObservationCapture>>) {
  return {
    traceId: "trace_capture_boundary", kind: "terminal" as const, seq: 1,
    occurredAt: "2026-07-25T00:00:00.000Z", profileId: "profile_capture", keyId: null,
    routeId: null, offeringId: null, status: 200, reasonCodes: [], capture,
  };
}

test("gateway capture tee requires a signed payload policy and never returns an oversized body", () => {
  assert.equal(boundedObservationCapture(undefined, { prompt: "secret" }, { answer: "ok" }), undefined);
  const retained = boundedObservationCapture({ mode: "redacted", maxBytes: 512 }, { prompt: "hello" }, { answer: "ok" });
  assert.deepEqual(retained, { mode: "redacted", request: { prompt: "hello" }, response: { answer: "ok" }, bytes: 57 });
  const redacted = boundedObservationCapture({ mode: "redacted", maxBytes: 512 }, { authorization: "Bearer capture-secret" }, { diagnostic: "Bearer capture-value" });
  assert.doesNotMatch(JSON.stringify(redacted), /capture-(?:secret|value)/);
  assert.match(JSON.stringify(redacted), /\[REDACTED\]/);
  const truncated = boundedObservationCapture({ mode: "full", maxBytes: 32 }, { prompt: "x".repeat(128) }, undefined);
  assert.deepEqual(truncated, { mode: "full", truncated: true, bytes: 0 });
});

test("gateway emits a terminal capture accepted at the complete 4096-byte ingest boundary", () => {
  const policy = { mode: "full" as const, maxBytes: 4_096 };
  let atLimit: NonNullable<ReturnType<typeof boundedObservationCapture>> | undefined;
  for (let length = 0; length <= 4_096; length += 1) {
    const capture = boundedObservationCapture(policy, { text: "x".repeat(length) }, undefined);
    if (capture && !capture.truncated && new TextEncoder().encode(JSON.stringify(capture)).byteLength === 4_096) {
      atLimit = capture;
      break;
    }
  }
  assert.ok(atLimit, "test fixture must reach the exact transport boundary");
  assert.equal(ObservationIngestContracts.batch.safeParse({ events: [terminalWithCapture(atLimit)] }).success, true);
});

test("gateway truncates an over-limit terminal capture into an ingest-valid marker", () => {
  let request: Record<string, unknown> | undefined;
  for (let length = 0; length <= 4_096; length += 1) {
    const candidate = { text: "x".repeat(length) };
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ request: candidate })).byteLength;
    const envelopeBytes = new TextEncoder().encode(JSON.stringify({ mode: "full", request: candidate, bytes: payloadBytes })).byteLength;
    if (payloadBytes <= 4_096 && envelopeBytes > 4_096) {
      request = candidate;
      break;
    }
  }
  assert.ok(request, "test fixture must fit the policy payload cap while exceeding the transport cap");
  const capture = boundedObservationCapture({ mode: "full", maxBytes: 4_096 }, request, undefined);
  assert.deepEqual(capture, { mode: "full", truncated: true, bytes: 0 });
  assert.equal(ObservationIngestContracts.batch.safeParse({ events: [terminalWithCapture(capture)] }).success, true);
});
