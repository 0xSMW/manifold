import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeProviderErrorResponse } from "../src/providerErrors.ts";

test("normalizes Anthropic-style JSON while preserving status and retry hints", async () => {
  const response = await normalizeProviderErrorResponse(new Response(JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", message: "provider is overloaded" },
  }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": "3",
    },
  }), "trace_1");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal(response.headers.get("x-trace-id"), "trace_1");
  assert.deepEqual(await response.json(), {
    error: {
      message: "provider is overloaded",
      type: "rate_limit_error",
      param: null,
      code: "provider_error",
    },
  });
});

test("does not relay provider authentication detail", async () => {
  const response = await normalizeProviderErrorResponse(new Response(JSON.stringify({
    error: { message: "invalid bearer secret sk-provider-secret" },
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  }), "trace_2");
  assert.equal((await response.json() as { error: { message: string } }).error.message, "provider authentication failed");
});

test("bounds chunked provider error bodies and returns a generic OpenAI shape", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":{"message":"'));
      controller.enqueue(new Uint8Array(100));
    },
    cancel() {
      cancelled = true;
    },
  }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
  const response = await normalizeProviderErrorResponse(upstream, "trace_3", 16);
  assert.equal(cancelled, true);
  assert.equal((await response.json() as { error: { message: string } }).error.message, "provider request failed");
});
