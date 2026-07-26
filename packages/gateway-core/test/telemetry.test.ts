import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryTelemetry,
  startRequestTelemetry,
  type RequestSpanStart,
} from "../src/telemetry.ts";

const request: RequestSpanStart = {
  installationId: "installation_01",
  profileId: "profile_01",
  routeId: "route_01",
  endpoint: "chat",
};

test("records a successful request with bounded duration, metrics, and structured log", () => {
  const recorder = new InMemoryTelemetry();
  const clock = sequence(100, 125);
  const lifecycle = startRequestTelemetry(recorder, request, clock);
  lifecycle.end({ outcome: "success", statusCode: 200 });

  assert.deepEqual(recorder.spans[0], {
    kind: "request",
    start: request,
    end: { outcome: "success", statusCode: 200 },
    endCount: 1,
  });
  assert.deepEqual(recorder.metrics.map(({ name, value }) => ({ name, value })), [
    { name: "gateway.request.duration_ms", value: 25 },
    { name: "gateway.request.count", value: 1 },
  ]);
  assert.deepEqual(recorder.logs, [{ event: "request.finished", outcome: "success", statusCode: 200 }]);
});

test("records child attempts and retry/failover outcomes", () => {
  const recorder = new InMemoryTelemetry();
  const clock = sequence(0, 10, 20, 30, 40, 60);
  const lifecycle = startRequestTelemetry(recorder, request, clock);
  const first = lifecycle.startAttempt({ attempt: 1, provider: "openai" });
  first.end({ outcome: "error", statusCode: 503, reason: "provider_error", retried: true, failedOver: true });
  const second = lifecycle.startAttempt({ attempt: 2, provider: "anthropic" });
  second.end({ outcome: "success", statusCode: 200 });
  lifecycle.end({ outcome: "success", statusCode: 200, retryCount: 1, failoverCount: 1 });

  assert.equal(recorder.spans.length, 3);
  assert.equal(recorder.spans[1]?.kind, "provider_attempt");
  assert.equal(recorder.spans[1]?.parent, recorder.spans[0]);
  assert.deepEqual(recorder.spans[1]?.end, {
    outcome: "error", statusCode: 503, reason: "provider_error", retried: true, failedOver: true,
  });
  assert.deepEqual(recorder.spans[0]?.end, { outcome: "success", statusCode: 200, retryCount: 1, failoverCount: 1 });
});

test("records request and attempt errors", () => {
  const recorder = new InMemoryTelemetry();
  const lifecycle = startRequestTelemetry(recorder, request, sequence(0, 1, 2, 3));
  const attempt = lifecycle.startAttempt({ attempt: 1, provider: "provider" });
  attempt.end({ outcome: "error", reason: "timeout" });
  lifecycle.end({ outcome: "error", reason: "timeout" });

  assert.equal(recorder.spans[1]?.end?.outcome, "error");
  assert.equal(recorder.spans[0]?.end?.reason, "timeout");
  assert.equal(recorder.logs[0]?.event, "provider_attempt.finished");
  assert.equal(recorder.logs[1]?.event, "request.finished");
});

test("ending lifecycle spans multiple times emits exactly one terminal record", () => {
  const recorder = new InMemoryTelemetry();
  const lifecycle = startRequestTelemetry(recorder, request, sequence(0, 1, 2, 3, 4, 5));
  const attempt = lifecycle.startAttempt({ attempt: 1, provider: "provider" });
  attempt.end({ outcome: "success" });
  attempt.end({ outcome: "error", reason: "internal_error" });
  lifecycle.end({ outcome: "success" });
  lifecycle.end({ outcome: "error", reason: "internal_error" });

  assert.equal(recorder.spans[0]?.endCount, 1);
  assert.equal(recorder.spans[1]?.endCount, 1);
  assert.equal(recorder.metrics.length, 4);
  assert.equal(recorder.logs.length, 2);
});

test("runtime sanitization drops credential-like values, URLs, and invalid status values", () => {
  const recorder = new InMemoryTelemetry();
  const unsafe = {
    installationId: "sk-live-credential",
    profileId: "https://provider.example/v1/chat",
    routeId: "route_01",
    provider: "Bearer_token",
    endpoint: "chat" as const,
  };
  const lifecycle = startRequestTelemetry(recorder, unsafe, sequence(0, 1));
  lifecycle.end({ outcome: "rejected", statusCode: 999, reason: "budget_denied" });

  assert.deepEqual(recorder.spans[0]?.start, { routeId: "route_01", endpoint: "chat" });
  assert.deepEqual(recorder.spans[0]?.end, { outcome: "rejected", reason: "budget_denied" });
  assert.doesNotMatch(JSON.stringify(recorder), /sk-live|https?:\/\/|Bearer_token/);
});

function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
