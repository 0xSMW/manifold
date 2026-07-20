// packages/domain/src/machines/storageTier.ts — storage tier lifecycle (SPEC §5.4, §13.3).
//
// `normal(<70%) → warning(70) → high(85) → critical(95) → emergency(100)`; recovers
// downward. Unlike the other machines, this one is a pure function of a *measurement*
// (`used_pct` of the effective ceiling), not a sequence of discrete business events: the
// tier is recomputed from scratch on every `MEASURE` event and may move directly to any
// other tier (up on pressure, or down several tiers at once after a compaction pass
// reclaims a lot of space). There is no terminal state — it cycles for the life of the
// installation. Any event other than `MEASURE`, or a non-finite/negative `usedPct`, is an
// illegal transition.
import { invalidTransition, ok, type Transition } from "./types.js";

export type StorageTierState =
  | "normal"
  | "warning"
  | "high"
  | "critical"
  | "emergency";

export const STORAGE_TIER_STATES: readonly StorageTierState[] = [
  "normal",
  "warning",
  "high",
  "critical",
  "emergency",
];

/** No terminal state — the tier recovers downward as footprint is reclaimed (SPEC §5.4). */
export const STORAGE_TIER_TERMINAL_STATES: readonly StorageTierState[] = [];

export type StorageTierEvent = {
  type: "MEASURE";
  /** Percentage (0-100+) of the effective storage ceiling currently used. */
  usedPct: number;
};

/** Threshold table from SPEC §13.3, in ascending order. */
export const STORAGE_TIER_THRESHOLDS: ReadonlyArray<{
  tier: StorageTierState;
  atLeastPct: number;
}> = [
  { tier: "normal", atLeastPct: 0 },
  { tier: "warning", atLeastPct: 70 },
  { tier: "high", atLeastPct: 85 },
  { tier: "critical", atLeastPct: 95 },
  { tier: "emergency", atLeastPct: 100 },
];

/** Map a raw `usedPct` measurement to its storage tier (SPEC §13.3). */
export function tierForUsedPct(usedPct: number): StorageTierState {
  let tier: StorageTierState = "normal";
  for (const row of STORAGE_TIER_THRESHOLDS) {
    if (usedPct >= row.atLeastPct) tier = row.tier;
  }
  return tier;
}

export function transitionStorageTier(
  _state: StorageTierState,
  event: StorageTierEvent,
): Transition<StorageTierState> {
  if (event.type !== "MEASURE") return invalidTransition();
  if (!Number.isFinite(event.usedPct) || event.usedPct < 0) return invalidTransition();
  return ok(tierForUsedPct(event.usedPct));
}
