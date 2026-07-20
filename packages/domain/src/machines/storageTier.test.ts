// packages/domain/src/machines/storageTier.test.ts — SPEC §5.4, §13.3.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STORAGE_TIER_TERMINAL_STATES,
  tierForUsedPct,
  transitionStorageTier,
} from "./storageTier.js";
import { expectInvalid, expectOk } from "./transitionTestKit.js";

test("tierForUsedPct maps usage to the SPEC §13.3 tier boundaries", () => {
  assert.equal(tierForUsedPct(0), "normal");
  assert.equal(tierForUsedPct(69.9), "normal");
  assert.equal(tierForUsedPct(70), "warning");
  assert.equal(tierForUsedPct(84.9), "warning");
  assert.equal(tierForUsedPct(85), "high");
  assert.equal(tierForUsedPct(94.9), "high");
  assert.equal(tierForUsedPct(95), "critical");
  assert.equal(tierForUsedPct(99.9), "critical");
  assert.equal(tierForUsedPct(100), "emergency");
  assert.equal(tierForUsedPct(150), "emergency");
});

test("every legal transition succeeds, including jumping tiers directly (recovers downward)", () => {
  expectOk(transitionStorageTier, "normal", { type: "MEASURE", usedPct: 92 }, "high");
  expectOk(transitionStorageTier, "emergency", { type: "MEASURE", usedPct: 10 }, "normal");
  expectOk(transitionStorageTier, "critical", { type: "MEASURE", usedPct: 95 }, "critical");
  // There is no terminal state — this machine cycles for the life of the installation.
  assert.deepEqual(STORAGE_TIER_TERMINAL_STATES.length, 0);
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  expectInvalid(
    transitionStorageTier,
    "normal",
    // @ts-expect-error exercising a malformed event at runtime
    { type: "COMPACT" },
  );
  expectInvalid(transitionStorageTier, "normal", { type: "MEASURE", usedPct: -5 });
  expectInvalid(transitionStorageTier, "normal", { type: "MEASURE", usedPct: Number.NaN });
});
