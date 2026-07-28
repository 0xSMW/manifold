import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotTarget } from "@manifold/ports";
import { FakeCrypto } from "@manifold/ports/testing";
import {
  decideRetry,
  deriveProviderIdempotencyKey,
  isSafePostRetry,
  normalizeRetryPolicy,
  orderTargetAttempts,
  parseRetryAfterMs,
  providerIdempotencyContractFromSnapshot,
  retryDelayMs,
  snapshotTargetIdentity,
} from "../src/retry.ts";
import { headerAllowlist } from "../src/headers.ts";

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
    idempotencyKey: "retry-key",
    providerIdempotencyContract: { targetId: "target-safe", headerName: "idempotency-key" as const },
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
    idempotencyKey: "retry-key",
    providerIdempotencyContract: { targetId: "target-safe", headerName: "idempotency-key" },
    startedAtMs: 1_000,
    deadlineMs: 2_500,
    nowMs: 2_000,
  }), { retry: false, reason: "deadline" });
  assert.deepEqual(decideRetry({
    completedAttempt: 1,
    failure: { timedOut: true },
    responseBytesReceived: 0,
    idempotencyKey: "retry-key",
    providerIdempotencyContract: { targetId: "target-safe", headerName: "idempotency-key" },
    startedAtMs: 1_000,
    deadlineMs: 2_500,
    nowMs: 2_000,
  }), { retry: true, delayMs: 100 });
});

test("never replays an ambiguous billable POST without a target-scoped provider contract", () => {
  assert.equal(isSafePostRetry(0), false);
  assert.equal(isSafePostRetry(1), false);
  assert.equal(isSafePostRetry(1, "   "), false);
  assert.equal(isSafePostRetry(0, "request-123"), false);
  assert.deepEqual(decideRetry({
    completedAttempt: 1,
    failure: { networkError: true },
    responseBytesReceived: 42,
    startedAtMs: 0,
    deadlineMs: 10_000,
    nowMs: 100,
  }), { retry: false, reason: "unsafe_post" });
});

test("accepts only an explicit target-scoped provider idempotency contract", () => {
  const contract = providerIdempotencyContractFromSnapshot({
    provider_idempotency: { target_id: "target-a", header_name: "idempotency-key" },
  });
  assert.deepEqual(contract, { targetId: "target-a", headerName: "idempotency-key" });
  assert.equal(isSafePostRetry(0, "request-123", contract), true);
  assert.equal(providerIdempotencyContractFromSnapshot({
    provider_idempotency: { target_id: "target-a", header_name: "Idempotency-Key" },
  }), undefined);
  assert.equal(providerIdempotencyContractFromSnapshot({
    provider_idempotency: { target_id: "target-a", header_name: "idempotency-key", scope: "provider" },
  }), undefined);
});

test("does not forward an inbound Idempotency-Key unless dispatch supplies a target-scoped key", () => {
  const inbound = new Headers({ "content-type": "application/json", "idempotency-key": "client-key" });
  assert.equal(headerAllowlist(inbound).get("idempotency-key"), null);
  assert.equal(headerAllowlist(inbound, { providerIdempotencyKey: "target-key" }).get("idempotency-key"), "target-key");
});

test("derives a stable, bounded provider key without exposing the client key across targets", async () => {
  const crypto = new FakeCrypto();
  const pepper = new TextEncoder().encode("provider-idempotency-test-pepper");
  const clientKey = "client-secret-idempotency-key";
  const first = await deriveProviderIdempotencyKey(crypto, pepper, "installation-a", "target-a", clientKey);
  const repeat = await deriveProviderIdempotencyKey(crypto, pepper, "installation-a", "target-a", clientKey);
  const otherTarget = await deriveProviderIdempotencyKey(crypto, pepper, "installation-a", "target-b", clientKey);
  const otherInstallation = await deriveProviderIdempotencyKey(crypto, pepper, "installation-b", "target-a", clientKey);
  assert.ok(first);
  assert.equal(first, repeat, "a retry to the persisted target must reuse the provider key");
  assert.notEqual(first, otherTarget, "a provider key must not cross a target boundary");
  assert.notEqual(first, otherInstallation, "a provider key must not cross an installation boundary");
  assert.match(first, /^mf_[A-Za-z0-9_-]{43}$/u);
  assert.equal(first.includes(clientKey), false);
  assert.equal((await deriveProviderIdempotencyKey(crypto, pepper, "installation-a", "target-a", "x".repeat(1_025))), undefined);
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
