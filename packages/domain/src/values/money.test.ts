// packages/domain/src/values/money.test.ts — banker's rounding + cost computation fixtures (SPEC §6.10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCost, computeCostChecked, costMicroUsd, roundHalfEven } from "./money.js";
import { ZERO_TOKEN_COUNTS } from "./tokenCounts.js";

test("roundHalfEven: exhaustive x.5 ties round to nearest even integer", () => {
  const cases: Array<[bigint, bigint, bigint]> = [
    [1n, 2n, 0n], // 0.5 -> 0
    [3n, 2n, 2n], // 1.5 -> 2
    [5n, 2n, 2n], // 2.5 -> 2
    [7n, 2n, 4n], // 3.5 -> 4
    [9n, 2n, 4n], // 4.5 -> 4
    [11n, 2n, 6n], // 5.5 -> 6
    [-1n, 2n, 0n], // -0.5 -> 0 (round to even, -0 normalized to 0)
    [-3n, 2n, -2n], // -1.5 -> -2
    [-5n, 2n, -2n], // -2.5 -> -2
    [-7n, 2n, -4n], // -3.5 -> -4
  ];
  for (const [numerator, denominator, expected] of cases) {
    assert.equal(
      roundHalfEven(numerator, denominator),
      expected,
      `roundHalfEven(${numerator}, ${denominator})`,
    );
  }
});

test("roundHalfEven: non-tie cases round to nearest as usual", () => {
  assert.equal(roundHalfEven(24n, 10n), 2n); // 2.4 -> 2
  assert.equal(roundHalfEven(26n, 10n), 3n); // 2.6 -> 3
  assert.equal(roundHalfEven(21n, 10n), 2n); // 2.1 -> 2
  assert.equal(roundHalfEven(29n, 10n), 3n); // 2.9 -> 3
});

test("roundHalfEven: zero numerator and exact division", () => {
  assert.equal(roundHalfEven(0n, 7n), 0n);
  assert.equal(roundHalfEven(10n, 2n), 5n);
  assert.equal(roundHalfEven(-10n, 2n), -5n);
});

test("roundHalfEven: throws on zero denominator", () => {
  assert.throws(() => roundHalfEven(1n, 0n), RangeError);
});

test("costMicroUsd: exact per-mtok pricing (no rounding needed)", () => {
  // 1,000,000 tokens (1 mtok) at $15/mtok (15_000_000 µ$/mtok) = $15.00 = 15_000_000 µ$.
  assert.equal(costMicroUsd(1_000_000n, 15_000_000n), 15_000_000n);
});

test("costMicroUsd: ties round half to even at the microdollar", () => {
  // 3 tokens at 500_000 µ$/mtok -> numerator 1_500_000 / 1_000_000 = 1.5 -> ties to 2 (even).
  assert.equal(costMicroUsd(3n, 500_000n), 2n);
  // 1 token at 500_000 µ$/mtok -> numerator 500_000 / 1_000_000 = 0.5 -> ties to 0 (even).
  assert.equal(costMicroUsd(1n, 500_000n), 0n);
});

test("costMicroUsd: zero tokens or zero price is zero cost", () => {
  assert.equal(costMicroUsd(0n, 15_000_000n), 0n);
  assert.equal(costMicroUsd(1_000_000n, 0n), 0n);
});

test("computeCost: hand-computed fixture across all seven token classes (SPEC §6.10, A5/M7)", () => {
  const tokens = {
    inputTokens: 2_000_000n,
    outputTokens: 500_000n,
    cachedTokens: 1_000_000n,
    reasoningTokens: 200_000n,
    cacheWriteTokens: 100_000n,
    audioInputTokens: 50_000n,
    audioOutputTokens: 25_000n,
  };
  const price = {
    inputPerMtokMicroUsd: 3_000_000n, // $3 / mtok
    outputPerMtokMicroUsd: 15_000_000n, // $15 / mtok
    cacheReadPerMtokMicroUsd: 1_500_000n, // $1.50 / mtok
    reasoningPerMtokMicroUsd: 3_000_000n, // $3 / mtok
    cacheWritePerMtokMicroUsd: 3_750_000n, // $3.75 / mtok
    audioInPerMtokMicroUsd: 40_000_000n, // $40 / mtok
    audioOutPerMtokMicroUsd: 80_000_000n, // $80 / mtok
  };
  // Hand computation (µ$):
  //   input:       2_000_000 * 3_000_000  / 1e6 = 6_000_000
  //   output:        500_000 * 15_000_000 / 1e6 = 7_500_000
  //   cache_read:  1_000_000 * 1_500_000  / 1e6 = 1_500_000
  //   reasoning:     200_000 * 3_000_000  / 1e6 =   600_000
  //   cache_write:   100_000 * 3_750_000  / 1e6 =   375_000
  //   audio_in:       50_000 * 40_000_000 / 1e6 = 2_000_000
  //   audio_out:      25_000 * 80_000_000 / 1e6 = 2_000_000
  //   total                                       19_975_000  ($19.975)
  assert.equal(computeCost(tokens, price), 19_975_000n);
});

test("computeCost: a term that requires banker's rounding is rounded independently", () => {
  // reasoning: 3 tokens at 500_000 µ$/mtok -> 1.5 µ$ -> ties to 2 (even); every other
  // class is exactly-divisible so the sum isolates the rounded term.
  const tokens = {
    ...ZERO_TOKEN_COUNTS,
    inputTokens: 1_000_000n,
    reasoningTokens: 3n,
  };
  const price = {
    inputPerMtokMicroUsd: 1_000_000n, // $1/mtok -> exactly 1_000_000 µ$
    reasoningPerMtokMicroUsd: 500_000n,
  };
  assert.equal(computeCost(tokens, price), 1_000_002n);
});

test("computeCost: missing price fields default to zero cost for that class", () => {
  const tokens = {
    ...ZERO_TOKEN_COUNTS,
    inputTokens: 1_000_000n,
  };
  assert.equal(computeCost(tokens, { inputPerMtokMicroUsd: 1_000_000n }), 1_000_000n);
});

test("computeCostChecked: every needed price present ⇒ priceComplete true, cost == computeCost", () => {
  const tokens = { ...ZERO_TOKEN_COUNTS, inputTokens: 1_000_000n, outputTokens: 500_000n };
  const price = { inputPerMtokMicroUsd: 3_000_000n, outputPerMtokMicroUsd: 15_000_000n };
  const checked = computeCostChecked(tokens, price);
  assert.equal(checked.priceComplete, true);
  assert.equal(checked.microUsd, computeCost(tokens, price));
  assert.equal(checked.microUsd, 10_500_000n); // 3_000_000 (input) + 7_500_000 (output)
});

test("computeCostChecked: null output price WITH output tokens ⇒ priceComplete false (fail-closed signal)", () => {
  // The bug: a null per-class price is billed as µ$0, so real output tokens cost nothing and
  // the hard budget under-counts. The checked variant must FLAG this so callers fail closed.
  const tokens = { ...ZERO_TOKEN_COUNTS, inputTokens: 1_000_000n, outputTokens: 500_000n };
  const price = { inputPerMtokMicroUsd: 3_000_000n, outputPerMtokMicroUsd: null };
  const checked = computeCostChecked(tokens, price);
  assert.equal(checked.priceComplete, false, "a null price for billed output tokens is unknown, not free");
  // Same silently-cheap total computeCost would produce — the caller must not trust it.
  assert.equal(checked.microUsd, computeCost(tokens, price));
  assert.equal(checked.microUsd, 3_000_000n); // output tokens contributed µ$0
});

test("computeCostChecked: missing (undefined) output price WITH output tokens ⇒ priceComplete false", () => {
  const tokens = { ...ZERO_TOKEN_COUNTS, outputTokens: 500_000n };
  const checked = computeCostChecked(tokens, { inputPerMtokMicroUsd: 3_000_000n });
  assert.equal(checked.priceComplete, false);
});

test("computeCostChecked: null price for a class with ZERO tokens ⇒ priceComplete true (no cost lost)", () => {
  const tokens = { ...ZERO_TOKEN_COUNTS, inputTokens: 1_000_000n };
  const checked = computeCostChecked(tokens, {
    inputPerMtokMicroUsd: 3_000_000n,
    outputPerMtokMicroUsd: null, // no output tokens → this gap costs nothing
  });
  assert.equal(checked.priceComplete, true);
  assert.equal(checked.microUsd, 3_000_000n);
});

test("computeCostChecked: explicit 0n price is a KNOWN price (free tier), not a gap ⇒ priceComplete true", () => {
  const tokens = { ...ZERO_TOKEN_COUNTS, inputTokens: 1_000_000n, outputTokens: 500_000n };
  const checked = computeCostChecked(tokens, {
    inputPerMtokMicroUsd: 3_000_000n,
    outputPerMtokMicroUsd: 0n,
  });
  assert.equal(checked.priceComplete, true, "0n is a known zero price, not an unknown one");
  assert.equal(checked.microUsd, 3_000_000n);
});
