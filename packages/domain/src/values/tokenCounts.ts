// packages/domain/src/values/tokenCounts.ts — typed token-count record.
//
// Mirrors the token columns on `observation` (SPEC §6.8) and the §6.10 cost formula's
// inputs. All counts are non-negative bigints; a class with no tokens is `0n` (never
// `undefined` on a fully-formed record — `undefined` is only tolerated at the
// `computeCost` call boundary for partially known observations).
export interface TokenCounts {
  inputTokens: bigint;
  outputTokens: bigint;
  cachedTokens: bigint; // cache_read
  reasoningTokens: bigint;
  cacheWriteTokens: bigint; // A5/M7
  audioInputTokens: bigint; // A5/M7
  audioOutputTokens: bigint; // A5/M7
}

/** A `TokenCounts` with every class zeroed — a convenient base for partial fixtures. */
export const ZERO_TOKEN_COUNTS: TokenCounts = {
  inputTokens: 0n,
  outputTokens: 0n,
  cachedTokens: 0n,
  reasoningTokens: 0n,
  cacheWriteTokens: 0n,
  audioInputTokens: 0n,
  audioOutputTokens: 0n,
};
