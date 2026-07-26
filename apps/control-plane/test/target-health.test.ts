import assert from "node:assert/strict";
import test from "node:test";
import { deriveTargetHealth, TARGET_HEALTH_EVIDENCE_TTL_MS } from "../lib/target-health.ts";

const now = new Date("2026-07-25T12:00:00.000Z");
const ago = (milliseconds: number) => new Date(now.getTime() - milliseconds);

test("target-health becomes unhealthy only after five transient failures in its bounded window", () => {
  const decision = deriveTargetHealth({ now, previous: "healthy", evidence: Array.from({ length: 5 }, (_, index) => ({ outcome: "transient_failure" as const, occurredAt: ago(index * 1_000) })) });
  assert.deepEqual({ state: decision.state, attempts: decision.attempts, transientFailures: decision.transientFailures, transientRatio: decision.transientRatio }, { state: "unhealthy", attempts: 5, transientFailures: 5, transientRatio: 1 });
});

test("target-health degrades at a fifty-percent transient ratio below the unhealthy threshold", () => {
  const decision = deriveTargetHealth({ now, previous: "healthy", evidence: [{ outcome: "transient_failure", occurredAt: ago(1_000) }, { outcome: "success", occurredAt: ago(2_000) }] });
  assert.equal(decision.state, "degraded");
  assert.equal(decision.transientRatio, 0.5);
});

test("target-health holds degraded and unhealthy states until three newest successes prove recovery", () => {
  const two = deriveTargetHealth({ now, previous: "unhealthy", evidence: [{ outcome: "success", occurredAt: ago(1_000) }, { outcome: "success", occurredAt: ago(2_000) }, { outcome: "transient_failure", occurredAt: ago(3_000) }] });
  assert.equal(two.state, "unhealthy");
  const three = deriveTargetHealth({ now, previous: "degraded", evidence: [{ outcome: "success", occurredAt: ago(1_000) }, { outcome: "success", occurredAt: ago(2_000) }, { outcome: "success", occurredAt: ago(3_000) }] });
  assert.equal(three.state, "healthy");
});

test("permanent failures never count as recovery successes", () => {
  const decision = deriveTargetHealth({ now, previous: "unhealthy", evidence: [
    { outcome: "success", occurredAt: ago(1_000) },
    { outcome: "success", occurredAt: ago(2_000) },
    { outcome: "permanent_failure", occurredAt: ago(3_000) },
  ] });
  assert.equal(decision.consecutiveSuccesses, 2);
  assert.equal(decision.state, "unhealthy");
});

test("target-health expires to unknown after evidence TTL even when old window facts remain", () => {
  const decision = deriveTargetHealth({ now, previous: "healthy", evidence: [{ outcome: "success", occurredAt: ago(TARGET_HEALTH_EVIDENCE_TTL_MS + 1) }] });
  assert.equal(decision.state, "unknown");
});
