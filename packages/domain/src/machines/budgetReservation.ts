// packages/domain/src/machines/budgetReservation.ts — budget reservation lifecycle (SPEC §5.4, §8.4).
//
// `reserved → committed` / `rolled_back` / `expired`. Terminal: `committed`,
// `rolled_back`, `expired`.
import { invalidTransition, ok, type Transition } from "./types.js";

export const BUDGET_RESERVATION_STATES = [
  "reserved",
  "committed",
  "rolled_back",
  "expired",
] as const;

/** Union of every state, derived from the single-source states list above. */
export type BudgetReservationState = (typeof BUDGET_RESERVATION_STATES)[number];

export const BUDGET_RESERVATION_TERMINAL_STATES: readonly BudgetReservationState[] = [
  "committed",
  "rolled_back",
  "expired",
];

export type BudgetReservationEvent =
  /** reserved → committed: actual cost known; move reserved → committed by actual.
   *  Named on the product verb `commit()` (P1-7 rename; formerly `RECONCILE`). */
  | { type: "COMMIT" }
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
        case "COMMIT":
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
