// packages/domain/src/values/money.ts — integer micro-USD money and cost computation.
//
// SPEC §6.10 (normative): cost is integer arithmetic on µ$ per 1M tokens (ADR-0008).
// No floats, ever — every quantity here is a bigint. Rounding is banker's rounding
// (round-half-to-even) applied per token-class term, then the terms are summed.
import type { TokenCounts } from "./tokenCounts.js";

/** Integer micro-USD (1 USD == 1_000_000 MicroUsd). Always a bigint — never a float. */
export type MicroUsd = bigint;

const MTOK: bigint = 1_000_000n;

/**
 * Banker's rounding (round-half-to-even) of `numerator / denominator` to the nearest
 * integer. Ties (remainder exactly half of denominator) round to the nearest even
 * integer, which keeps aggregate rounding drift centered on zero (SPEC §6.10).
 *
 * Pure bigint arithmetic — no floating point is ever introduced.
 */
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError("roundHalfEven: denominator must not be zero");
  }
  // Normalize sign so the core algorithm only deals with non-negative values;
  // round-half-even is symmetric around zero.
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;
  const twiceRemainder = remainder * 2n;

  let rounded = quotient;
  if (twiceRemainder > d) {
    // Strictly more than half way: round up.
    rounded = quotient + 1n;
  } else if (twiceRemainder === d) {
    // Exactly half way: round to even.
    if (quotient % 2n !== 0n) {
      rounded = quotient + 1n;
    }
  }
  return negative ? -rounded : rounded;
}

/**
 * Cost in µ$ for `tokens` billed at `pricePerMtokMicroUsd` (price per 1,000,000 tokens,
 * in µ$). Equivalent to `round_half_even(tokens * pricePerMtokMicroUsd / 1_000_000)`
 * (SPEC §6.10).
 */
export function costMicroUsd(
  tokens: bigint,
  pricePerMtokMicroUsd: bigint,
): MicroUsd {
  return roundHalfEven(tokens * pricePerMtokMicroUsd, MTOK);
}

/**
 * Per-mtok µ$ prices for every token class in the SPEC §6.10 cost formula. Mirrors
 * `provider_price_revision` (SPEC §6.4). All fields optional/nullable to mirror the
 * DB columns; a missing price is treated as zero cost for that class.
 */
export interface PriceMicroUsd {
  inputPerMtokMicroUsd?: bigint | null;
  outputPerMtokMicroUsd?: bigint | null;
  cacheReadPerMtokMicroUsd?: bigint | null;
  cacheWritePerMtokMicroUsd?: bigint | null; // A5/M7
  reasoningPerMtokMicroUsd?: bigint | null;
  audioInPerMtokMicroUsd?: bigint | null; // A5/M7
  audioOutPerMtokMicroUsd?: bigint | null; // A5/M7
}

function term(tokens: bigint | null | undefined, price: bigint | null | undefined): MicroUsd {
  return costMicroUsd(tokens ?? 0n, price ?? 0n);
}

/**
 * Total observation cost in µ$: the sum of `round_half_even` per token class
 * (SPEC §6.10, A5/M7). Each term is rounded independently before summing, per the
 * normative formula — summing first and rounding once would NOT be equivalent and
 * would drift from the DB-computed truth.
 */
export function computeCost(tokens: TokenCounts, price: PriceMicroUsd): MicroUsd {
  return (
    term(tokens.inputTokens, price.inputPerMtokMicroUsd) +
    term(tokens.outputTokens, price.outputPerMtokMicroUsd) +
    term(tokens.cacheReadTokens, price.cacheReadPerMtokMicroUsd) +
    term(tokens.reasoningTokens, price.reasoningPerMtokMicroUsd) +
    term(tokens.cacheWriteTokens, price.cacheWritePerMtokMicroUsd) +
    term(tokens.audioInputTokens, price.audioInPerMtokMicroUsd) +
    term(tokens.audioOutputTokens, price.audioOutPerMtokMicroUsd)
  );
}

/**
 * Result of {@link computeCostChecked}: the µ$ cost plus whether every per-class price that
 * was actually NEEDED (a class with a positive token count) was present.
 *
 * `priceComplete === false` means at least one billed token class had a `null`/absent price,
 * so `microUsd` UNDER-counts (that class contributed µ$0 rather than its true cost). Hard-budget
 * and reservation callers MUST fail closed on this (e.g. `BUDGET_PRICE_UNKNOWN`) instead of
 * trusting a silently-cheap total; soft/observability callers may still record `microUsd`.
 */
export interface CheckedCost {
  microUsd: MicroUsd;
  priceComplete: boolean;
}

// The seven SPEC §6.10 token classes paired with the price field each one is billed at.
// Iterated by both computeCost's shape and the completeness check so they can never diverge.
function pricePairs(
  tokens: TokenCounts,
  price: PriceMicroUsd,
): Array<[bigint | null | undefined, bigint | null | undefined]> {
  return [
    [tokens.inputTokens, price.inputPerMtokMicroUsd],
    [tokens.outputTokens, price.outputPerMtokMicroUsd],
    [tokens.cacheReadTokens, price.cacheReadPerMtokMicroUsd],
    [tokens.reasoningTokens, price.reasoningPerMtokMicroUsd],
    [tokens.cacheWriteTokens, price.cacheWritePerMtokMicroUsd],
    [tokens.audioInputTokens, price.audioInPerMtokMicroUsd],
    [tokens.audioOutputTokens, price.audioOutPerMtokMicroUsd],
  ];
}

/**
 * Strict variant of {@link computeCost} for fail-closed callers (hard budget, reservations).
 *
 * Returns the SAME µ$ total `computeCost` would (a `null` price still contributes µ$0), but
 * ALSO reports `priceComplete`: `false` when any token class with a positive count has a
 * `null`/absent price — i.e. real tokens were billed at an UNKNOWN (silently zero) price and
 * the total is an under-count. A class with zero tokens never trips it (a missing price for a
 * class that produced no tokens costs nothing regardless). An explicit `0n` price is a KNOWN
 * price (free tier), not a gap, so it keeps `priceComplete === true`.
 *
 * `computeCost` is intentionally left unchanged so existing (soft) callers keep their behavior.
 */
export function computeCostChecked(tokens: TokenCounts, price: PriceMicroUsd): CheckedCost {
  let priceComplete = true;
  for (const [tok, p] of pricePairs(tokens, price)) {
    if ((tok ?? 0n) > 0n && (p === null || p === undefined)) {
      priceComplete = false;
      break;
    }
  }
  return { microUsd: computeCost(tokens, price), priceComplete };
}
