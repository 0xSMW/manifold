import assert from "node:assert/strict";
import test from "node:test";
import { effectiveCeilingBytes, forecastExhaustionAt, growthBytesPerDay, isTraceSampledIn, policyForStoragePressure, tierForStoragePressure, usedPct } from "../src/pressure-policy.js";

test("storage pressure classification uses workspace thresholds against the effective ceiling", () => {
  const effective = effectiveCeilingBytes({ ceilingBytes: 1_000, indexBytes: 20, heapBytes: 800 });
  assert.equal(effective, 920, "8% migration headroom dominates the measured index reserve");
  const at = (pct: number) => tierForStoragePressure({ usedPct: pct, warnPct: 70, highPct: 85, critPct: 95 });
  assert.equal(at(69.999), "normal");
  assert.equal(at(70), "warning");
  assert.equal(at(85), "high");
  assert.equal(at(95), "critical");
  assert.equal(at(100), "emergency");
  assert.equal(usedPct(782, effective), 85);
});

test("growth regression and exhaustion forecast use measured timestamps and effective headroom", () => {
  const growth = growthBytesPerDay([
    { measuredAt: new Date("2026-07-25T00:00:00Z"), totalBytes: 100 },
    { measuredAt: new Date("2026-07-25T00:15:00Z"), totalBytes: 125 },
    { measuredAt: new Date("2026-07-25T00:45:00Z"), totalBytes: 175 },
  ]);
  assert.ok(Math.abs(growth! - 2_400) < 0.001);
  const forecast = forecastExhaustionAt({ measuredAt: new Date("2026-07-25T00:45:00Z"), totalBytes: 175, effectiveCeilingBytes: 2_575, growthBytesPerDay: growth });
  assert.ok(Math.abs(forecast!.valueOf() - new Date("2026-07-26T00:45:00Z").valueOf()) <= 1);
  assert.equal(forecastExhaustionAt({ measuredAt: new Date(), totalBytes: 100, effectiveCeilingBytes: 200, growthBytesPerDay: 0 }), null);
});

test("trace sampling is deterministic and bounded by the persisted rate", () => {
  assert.equal(isTraceSampledIn("trace-a", 0), false);
  assert.equal(isTraceSampledIn("trace-a", 1), true);
  assert.equal(isTraceSampledIn("trace-a", 0.5), isTraceSampledIn("trace-a", 0.5));
  assert.throws(() => isTraceSampledIn("trace-a", 1.01), /sample rate/);
});

test("pressure actions progressively reduce storage while preserving provider independence", () => {
  assert.deepEqual(policyForStoragePressure("warning"), { tier: "warning", captureMode: "full", payloadSampleRate: 0.5, journalMode: "full", triggerCompaction: true, compactEveryMeasure: false, blockNonEssentialGrowth: false });
  assert.deepEqual(policyForStoragePressure("high"), { tier: "high", captureMode: "redacted", payloadSampleRate: 0.1, journalMode: "full", triggerCompaction: true, compactEveryMeasure: true, blockNonEssentialGrowth: false });
  assert.equal(policyForStoragePressure("critical").captureMode, "metadata");
  assert.equal(policyForStoragePressure("emergency").journalMode, "aggregate_only");
  assert.deepEqual(policyForStoragePressure("normal"), { tier: "normal", captureMode: "full", payloadSampleRate: 1, journalMode: "full", triggerCompaction: false, compactEveryMeasure: false, blockNonEssentialGrowth: false });
});
