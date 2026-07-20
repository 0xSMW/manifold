// packages/domain/src/machines/budgetReservation.ts — budget reservation lifecycle (SPEC §5.4, §8.4).
//
// `reserved → committed` / `rolled_back` / `expired`. Terminal: `committed`,
// `rolled_back`, `expired`.
import { invalidTransition, ok, type Transition } from "./types.js";

export type BudgetReservationState =
  | "reserved"
  | "committed"
  | "rolled_back"
  | "expired";

export const BUDGET_RESERVATION_STATES: readonly BudgetReservationState[] = [
  "reserved",
  "committed",
  "rolled_back",
  "expired",
];

export const BUDGET_RESERVATION_TERMINAL_STATES: readonly BudgetReservationState[] = [
  "committed",
  "rolled_back",
  "expired",
];

export type BudgetReservationEvent =
  /** reserved → committed: actual cost known; move reserved → committed by actual. */
  | { type: "RECONCILE" }
  /** reserved → rolled_back: request rejected pre-dispatch or aborted before any tokens. */
  | { type: "ROLLBACK" }
  /** reserved → expired: reconciler sweep past expires_at with no terminal Observation. */
  | { type: "EXPIRE" };

export function transitionBudgetReservation(
  state: BudgetReservationState,
  event: BudgetReservationEvent,
): Transition<BudgetReservationState> {
  switch (state) {
    case "reserved":
      switch (event.type) {
        case "RECONCILE":
          return ok("committed");
        case "ROLLBACK":
          return ok("rolled_back");
        case "EXPIRE":
          return ok("expired");
      }
      return invalidTransition();

    case "committed":
    case "rolled_back":
    case "expired":
      // Terminal — no outgoing transitions.
      return invalidTransition();
  }
}
