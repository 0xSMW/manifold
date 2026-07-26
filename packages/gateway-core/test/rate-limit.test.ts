import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalRateLimiter, type MonotonicClock } from "../src/rateLimit.ts";

class TestClock implements MonotonicClock {
  private value: number;

  constructor(value = 0) {
    this.value = value;
  }
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
  set(ms: number): void {
    this.value = ms;
  }
}

function limiter(clock: TestClock, options: Partial<{ rpm: number; burst: number; tpm: number; maxEntries: number; idleTtlMs: number }> = {}) {
  return new LocalRateLimiter({ rpm: 2, tpm: 100, clock, ...options });
}

function consume(subject: LocalRateLimiter, estimatedTokens = 1, virtualKeyId = "key") {
  return subject.consume({ installationId: "installation", virtualKeyId, estimatedTokens });
}

test("admits a burst then refills requests at the configured RPM", () => {
  const clock = new TestClock();
  const subject = limiter(clock, { rpm: 2 });

  assert.equal(consume(subject).allowed, true);
  assert.equal(consume(subject).allowed, true);
  const denied = consume(subject);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "rpm");
  assert.equal(denied.retryAfterMs, 30_000);
  assert.equal(denied.retryAfterSeconds, 30);

  clock.advance(30_000);
  assert.equal(consume(subject).allowed, true);
});

test("uses an explicit burst capacity while refilling at the RPM rate", () => {
  const clock = new TestClock();
  const subject = limiter(clock, { rpm: 60, burst: 2 });

  assert.equal(consume(subject).allowed, true);
  assert.equal(consume(subject).allowed, true);
  assert.equal(consume(subject).allowed, false);
  clock.advance(1_000);
  assert.equal(consume(subject).allowed, true);
  assert.equal(consume(subject).allowed, false);
});

test("denies a request when estimated TPM is exhausted without consuming RPM", () => {
  const clock = new TestClock();
  const subject = limiter(clock, { rpm: 10, tpm: 100 });

  assert.equal(consume(subject, 90).allowed, true);
  const denied = consume(subject, 20);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "tpm");
  assert.equal(denied.retryAfterMs, 6_000);
  assert.equal(denied.remainingRequests, 9);
  clock.advance(6_000);
  assert.equal(consume(subject, 20).allowed, true);
});

test("isolates buckets by installation and virtual key", () => {
  const clock = new TestClock();
  const subject = limiter(clock, { rpm: 1 });

  assert.equal(consume(subject).allowed, true);
  assert.equal(consume(subject).allowed, false);
  assert.equal(consume(subject, 1, "another-key").allowed, true);
  assert.equal(
    subject.consume({ installationId: "another-installation", virtualKeyId: "key", estimatedTokens: 1 }).allowed,
    true,
  );
});

test("keeps cache memory bounded with LRU eviction and idle expiry", () => {
  const clock = new TestClock();
  const subject = limiter(clock, { rpm: 1, maxEntries: 2, idleTtlMs: 100 });

  assert.equal(consume(subject, 1, "oldest").allowed, true);
  assert.equal(consume(subject, 1, "recent").allowed, true);
  // Touch oldest: recent becomes LRU and is evicted for newest.
  assert.equal(consume(subject, 1, "oldest").allowed, false);
  assert.equal(consume(subject, 1, "newest").allowed, true);
  assert.equal(subject.size, 2);
  // recent was evicted, so a fresh bucket accepts immediately.
  assert.equal(consume(subject, 1, "recent").allowed, true);
  assert.equal(subject.size, 2);

  clock.advance(100);
  assert.equal(consume(subject, 1, "after-expiry").allowed, true);
  assert.equal(subject.size, 1);
});

test("a regressing clock never refills or expires a bucket", () => {
  const clock = new TestClock(1_000);
  const subject = limiter(clock, { rpm: 1, idleTtlMs: 100 });

  assert.equal(consume(subject).allowed, true);
  clock.set(0);
  const denied = consume(subject);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 60_000);
  assert.equal(subject.size, 1);
});

test("returns the longest retry-after needed by the two buckets", () => {
  const clock = new TestClock();
  const subject = limiter(clock, { rpm: 2, tpm: 100 });

  assert.equal(consume(subject, 80).allowed, true);
  assert.equal(consume(subject, 20).allowed, true);
  const denied = consume(subject, 50);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "rpm_and_tpm");
  assert.equal(denied.retryAfterMs, 30_000);
  assert.equal(denied.retryAfterSeconds, 30);
});
