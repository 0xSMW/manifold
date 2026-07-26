import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LocalCircuitBreaker,
  type CircuitBreakerClock,
  type CircuitTargetInput,
} from "../src/circuitBreaker.ts";
import type { SnapshotTarget } from "@manifold/ports";
import { snapshotTargetIdentity } from "../src/retry.ts";

class TestClock implements CircuitBreakerClock {
  private value: number;

  constructor(value = 0) {
    this.value = value;
  }
  now(): number { return this.value; }
  advance(ms: number): void { this.value += ms; }
  set(ms: number): void { this.value = ms; }
}

function target(targetId = "target", installationId = "installation"): CircuitTargetInput {
  return { installationId, targetId };
}

test("opens after the rolling failure threshold, permits one half-open probe, then recovers on success", () => {
  const clock = new TestClock();
  const subject = new LocalCircuitBreaker({ clock, failureThreshold: 2, rollingWindowMs: 100, resetTimeoutMs: 50 });

  assert.equal(subject.allow(target()).allowed, true);
  assert.equal(subject.recordFailure(target(), { status: 503 }), "closed");
  assert.equal(subject.recordFailure(target(), { timedOut: true }), "open");
  assert.deepEqual(subject.allow(target()), {
    allowed: false, state: "open", probe: false, retryAfterMs: 50, retryAfterSeconds: 1,
  });

  clock.advance(50);
  assert.deepEqual(subject.allow(target()), {
    allowed: true, state: "half_open", probe: true, retryAfterMs: 0, retryAfterSeconds: 0,
  });
  assert.equal(subject.allow(target()).allowed, false);
  subject.recordSuccess(target());
  assert.deepEqual(subject.allow(target()), {
    allowed: true, state: "closed", probe: false, retryAfterMs: 0, retryAfterSeconds: 0,
  });
  assert.deepEqual(subject.snapshot(), {
    capturedAtMs: 50,
    total: 1,
    closed: 1,
    open: 0,
    halfOpen: 0,
    entries: [{
      installationId: "installation", targetId: "target", state: "closed", failuresInWindow: 0,
      probeInFlight: false, retryAfterMs: 0, lastAccessMs: 50,
    }],
  });
});

test("a failed half-open probe reopens the circuit and non-transient 4xx never opens it", () => {
  const clock = new TestClock();
  const subject = new LocalCircuitBreaker({ clock, failureThreshold: 1, resetTimeoutMs: 20 });

  assert.equal(subject.recordFailure(target(), { status: 400 }), "closed");
  assert.equal(subject.allow(target()).allowed, true);
  assert.equal(subject.recordFailure(target(), { status: 429 }), "open");
  clock.advance(20);
  assert.equal(subject.allow(target()).probe, true);
  assert.equal(subject.recordFailure(target(), { networkError: true }), "open");
  assert.equal(subject.allow(target()).retryAfterMs, 20);
});

test("scopes state by installation and stable target identity", () => {
  const subject = new LocalCircuitBreaker({ failureThreshold: 1 });
  assert.equal(subject.recordFailure(target("provider-a", "installation-a"), { status: 500 }), "open");
  assert.equal(subject.allow(target("provider-a", "installation-a")).allowed, false);
  assert.equal(subject.allow(target("provider-b", "installation-a")).allowed, true);
  assert.equal(subject.allow(target("provider-a", "installation-b")).allowed, true);
});

test("separately persisted targets with one offering and credential keep distinct circuits", () => {
  const first: SnapshotTarget = {
    targetId: "target-first",
    offeringId: "offering-shared",
    credentialId: "credential-shared",
    dekId: "dek",
    credentialCiphertext: "ciphertext",
    wrappedDek: "wrapped",
    weight: 1,
    priority: 0,
    baseUrl: "https://provider.example",
    region: null,
    allowedHosts: ["provider.example"],
    authInject: { headers: {} },
  };
  const second = { ...first, targetId: "target-second" };
  const subject = new LocalCircuitBreaker({ failureThreshold: 1 });
  const firstCircuit = target(snapshotTargetIdentity(first));
  const secondCircuit = target(snapshotTargetIdentity(second));

  assert.equal(subject.recordFailure(firstCircuit, { status: 503 }), "open");
  assert.equal(subject.allow(firstCircuit).allowed, false);
  assert.equal(subject.allow(secondCircuit).allowed, true);
});

test("a regressing clock never shortens an open period or ages failures out", () => {
  const clock = new TestClock(1_000);
  const subject = new LocalCircuitBreaker({ clock, failureThreshold: 2, rollingWindowMs: 100, resetTimeoutMs: 50 });
  subject.recordFailure(target(), { status: 500 });
  clock.advance(10);
  subject.recordFailure(target(), { status: 503 });
  assert.equal(subject.allow(target()).retryAfterMs, 50);
  clock.set(0);
  assert.equal(subject.allow(target()).retryAfterMs, 50);
  assert.equal(subject.snapshot().entries[0]!.failuresInWindow, 2);
});

test("keeps state bounded using LRU eviction and idle expiry", () => {
  const clock = new TestClock();
  const subject = new LocalCircuitBreaker({ clock, failureThreshold: 1, maxEntries: 2, idleTtlMs: 100 });
  subject.recordFailure(target("oldest"), { status: 500 });
  assert.equal(subject.allow(target("recent")).allowed, true);
  // Touch oldest so recent becomes LRU; adding newest evicts recent.
  assert.equal(subject.allow(target("oldest")).allowed, false);
  assert.equal(subject.allow(target("newest")).allowed, true);
  assert.equal(subject.size, 2);
  assert.equal(subject.allow(target("recent")).allowed, true);
  assert.equal(subject.size, 2);

  clock.advance(100);
  assert.equal(subject.allow(target("after-expiry")).allowed, true);
  assert.equal(subject.size, 1);
});
