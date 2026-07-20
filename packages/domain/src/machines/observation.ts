// packages/domain/src/machines/observation.ts — observation lifecycle (SPEC §5.4, §8.3, §13).
//
// `event_appended → reduced → projected` (+ `compacted`). Terminal: `compacted`/`deleted`
// (§13 compaction lifecycle sheds detail while preserving durable truth).
import { invalidTransition, ok, type Transition } from "./types.js";

export type ObservationState =
  | "event_appended"
  | "reduced"
  | "projected"
  | "compacted"
  | "deleted";

export const OBSERVATION_STATES: readonly ObservationState[] = [
  "event_appended",
  "reduced",
  "projected",
  "compacted",
  "deleted",
];

export const OBSERVATION_TERMINAL_STATES: readonly ObservationState[] = [
  "compacted",
  "deleted",
];

export type ObservationEvent =
  /** event_appended → reduced: reduce(events for trace) → Observation (deterministic). */
  | { type: "REDUCE" }
  /** reduced → projected: project → trace_summary, usage_record, cost_ledger. */
  | { type: "PROJECT" }
  /** projected → compacted: rolled into hourly/daily/monthly usage_aggregate (§13.4). */
  | { type: "COMPACT" }
  /** compacted → deleted: dropped past retention floor in dependency order (§13.6). */
  | { type: "DELETE" };

export function transitionObservation(
  state: ObservationState,
  event: ObservationEvent,
): Transition<ObservationState> {
  switch (state) {
    case "event_appended":
      if (event.type === "REDUCE") return ok("reduced");
      return invalidTransition();

    case "reduced":
      if (event.type === "PROJECT") return ok("projected");
      return invalidTransition();

    case "projected":
      if (event.type === "COMPACT") return ok("compacted");
      return invalidTransition();

    case "compacted":
      if (event.type === "DELETE") return ok("deleted");
      return invalidTransition();

    case "deleted":
      // Terminal — no outgoing transitions.
      return invalidTransition();
  }
}
