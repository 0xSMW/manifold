import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotTarget } from "@manifold/ports";
import {
  decideRetry,
  isSafePostRetry,
  normalizeRetryPolicy,
  orderTargetAttempts,
  parseRetryAfterMs,
  retryDelayMs,
  snapshotTargetIdentity,
} from "../src/retry.ts";

function target(offeringId: string, credentialId: string): SnapshotTarget {
  return {
    offeringId,
    credentialId,
    dekId: "dek",
    credentialCiphertext: "ciphertext",
    wrappedDek: "wrapped",
    weight: 1,
    priority: 1,
    baseUrl: "https://provider.example",
    region: null,
    allowedHosts: ["provider.example"],
    authInject: { headers: {} },
  };
}

test("normalizes retry caps and caps exponential and server-directed delay", () => {
  assert.deepEqual(normalizeRetryPolicy({ maxAttempts: 99, baseBackoffMs: -5, maxBackoffMs: 99_999, maxRetryAfterMs: 99_999 }), {
    maxAttempts: 5,
    baseBackoffMs: 0,
    maxBackoffMs: 30_000,
    maxRetryAfterMs: 60_000,
    retryOn: ["408", "409", "429", "5xx", "timeout", "network"],
  });
  assert.equal(retryDelayMs(8, { baseBackoffMs: 100, maxBackoffMs: 1_000 }, undefined, 0), 1_000);
  assert.equal(retryDelayMs(1, { baseBackoffMs: 100, maxBackoffMs: 1_000, maxRetryAfterMs: 500 }, "60", 0), 500);
});

test("honors the route retry_on classifier", () => {
  const base = {
    completedAttempt: 1,
    responseBytesReceived: 0,
    startedAtMs: 0,
    deadlineMs: 10_000,
    nowMs: 100,
    policy: { retryOn: ["429"] as const },
  };
  assert.deepEqual(decideRetry({ ...base, failure: { status: 503 } }), {
    retry: false,
    reason: "not_retryable",
  });
  assert.deepEqual(decideRetry({ ...base, failure: { status: 429 } }), {
    retry: true,
    delayMs: 100,
  });
});

test("parses Retry-After delta seconds and HTTP date without accepting invalid values", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(parseRetryAfterMs("3", now), 3_000);
  assert.equal(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:02 GMT", now), 2_000);
  assert.equal(parseRetryAfterMs("Thu, 01 Jan 2025 00:00:00 GMT", now), 0);
  assert.equal(parseRetryAfterMs("1.5", now), undefined);
  assert.equal(parseRetryAfterMs("nonsense", now), undefined);
});

test("does not schedule a retry beyond the total route deadline", () => {
  assert.deepEqual(decideRetry({
    completedAttempt: 1,
    failure: { status: 429 },
    responseBytesReceived: 0,
    retryAfter: "2",
    startedAtMs: 1_000,
    deadlineMs: 2_500,
    nowMs: 2_000,
  }), { retry: false, reason: "deadline" });
  assert.deepEqual(decideRetry({
    completedAttempt: 1,
    failure: { timedOut: true },
    responseBytesReceived: 0,
    startedAtMs: 1_000,
    deadlineMs: 2_500,
    nowMs: 2_000,
  }), { retry: true, delayMs: 100 });
});

test("never replays a non-idempotent POST after response bytes, but accepts an Idempotency-Key", () => {
  assert.equal(isSafePostRetry(0), true);
  assert.equal(isSafePostRetry(1), false);
  assert.equal(isSafePostRetry(1, "   "), false);
  assert.equal(isSafePostRetry(1, "request-123"), true);
  assert.deepEqual(decideRetry({
    completedAttempt: 1,
    failure: { networkError: true },
    responseBytesReceived: 42,
    startedAtMs: 0,
    deadlineMs: 10_000,
    nowMs: 100,
  }), { retry: false, reason: "unsafe_post" });
});

test("orders the selected target first and preserves healthy order without repeats", () => {
  const selected = target("offering-a", "credential-a");
  const duplicate = target("offering-a", "credential-a");
  const second = target("offering-b", "credential-b");
  const third = target("offering-c", "credential-c");
  assert.deepEqual(
    orderTargetAttempts(selected, [duplicate, second, third, second]).map((entry) => entry.offeringId),
    ["offering-a", "offering-b", "offering-c"],
  );
});

test("keeps separately persisted targets eligible even when their offering and credential match", () => {
  const first = { ...target("offering-a", "credential-a"), targetId: "target-first" };
  const second = { ...target("offering-a", "credential-a"), targetId: "target-second" };
  const legacy = target("offering-a", "credential-a");

  assert.deepEqual(orderTargetAttempts(first, [second]), [first, second]);
  assert.notEqual(snapshotTargetIdentity(first), snapshotTargetIdentity(second));
  assert.equal(snapshotTargetIdentity(legacy), 'legacy:["offering-a","credential-a"]');
});
