import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalConcurrencyLimiter, limitRequestBody, type RuntimeLimitClock } from "../src/runtimeLimits.ts";

class TestClock implements RuntimeLimitClock {
  private value = 0;
  now(): number { return this.value; }
  advance(ms: number): void { this.value += ms; }
}

function requestFrom(stream: ReadableStream<Uint8Array>, headers?: HeadersInit): Request {
  return new Request("https://gateway.test/v1/chat/completions", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
}

test("request body limit accepts the exact byte boundary and returns a replayable request", async () => {
  const decision = await limitRequestBody(new Request("https://gateway.test/v1/x", { method: "POST", body: "12345" }), { maxBytes: 5 });
  assert.equal(decision.allowed, true);
  if (!decision.allowed) return;
  assert.equal(decision.bytes, 5);
  assert.equal(await decision.request.text(), "12345");
});

test("declared oversized content length is rejected without reading its stream", async () => {
  const body = new ReadableStream<Uint8Array>({ pull() { /* Undici may prefetch this source during Request construction. */ } });
  const request = requestFrom(body, { "content-length": "6" });
  const decision = await limitRequestBody(request, { maxBytes: 5 });
  assert.deepEqual(decision, { allowed: false, status: 413, code: "REQUEST_BODY_TOO_LARGE", limitBytes: 5, observedBytes: 6 });
  // bodyUsed remains false: the limiter never acquires the Request reader.
  assert.equal(request.bodyUsed, false);
});

test("chunked overflow cancels the source reader without retaining the oversized chunk", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("123456")); },
    cancel() { cancelled = true; },
  });
  const decision = await limitRequestBody(requestFrom(body), { maxBytes: 5 });
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.observedBytes, 6);
  assert.equal(cancelled, true);
});

test("concurrency limit applies key and global caps, and release is exactly once", () => {
  const subject = new LocalConcurrencyLimiter({ perKeyCap: 1, globalCap: 2 });
  const first = subject.acquire({ installationId: "i", virtualKeyId: "one" });
  assert.equal(first.allowed, true);
  const keyDenied = subject.acquire({ installationId: "i", virtualKeyId: "one" });
  assert.equal(keyDenied.allowed, false);
  if (!keyDenied.allowed) assert.equal(keyDenied.reason, "key_concurrency");
  const second = subject.acquire({ installationId: "i", virtualKeyId: "two" });
  assert.equal(second.allowed, true);
  const globalDenied = subject.acquire({ installationId: "i", virtualKeyId: "three" });
  assert.equal(globalDenied.allowed, false);
  if (!globalDenied.allowed) assert.equal(globalDenied.reason, "global_concurrency");
  if (!first.allowed || !second.allowed) return;
  first.release();
  first.release();
  assert.equal(subject.inFlight, 1);
  assert.equal(subject.acquire({ installationId: "i", virtualKeyId: "three" }).allowed, true);
  second.release();
});

test("concurrency registry remains bounded and does not evict active keys", () => {
  const clock = new TestClock();
  const subject = new LocalConcurrencyLimiter({ perKeyCap: 1, globalCap: 3, maxEntries: 2, idleTtlMs: 10, clock });
  const active = subject.acquire({ installationId: "i", virtualKeyId: "active" });
  assert.equal(active.allowed, true);
  const idle = subject.acquire({ installationId: "i", virtualKeyId: "idle" });
  assert.equal(idle.allowed, true);
  if (!idle.allowed || !active.allowed) return;
  idle.release();
  assert.equal(subject.acquire({ installationId: "i", virtualKeyId: "replacement" }).allowed, true);
  assert.equal(subject.size, 2);
  const noRoom = new LocalConcurrencyLimiter({ perKeyCap: 1, globalCap: 2, maxEntries: 1 });
  assert.equal(noRoom.acquire({ installationId: "i", virtualKeyId: "active" }).allowed, true);
  const denied = noRoom.acquire({ installationId: "i", virtualKeyId: "new" });
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.equal(denied.reason, "registry_capacity");
  clock.advance(10);
  active.release();
});
