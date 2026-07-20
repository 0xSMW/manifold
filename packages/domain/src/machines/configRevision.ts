// packages/domain/src/machines/configRevision.ts — config publishing lifecycle (SPEC §5.4, §8.2).
//
// `draft → planned → (tripwire_held?) → applying → active` / `rejected` / `superseded`.
// `active → rolled_back` (republish a prior revision) per §8.2's diagram. Terminal:
// `superseded`, `rejected`, `rolled_back`.
import { invalidTransition, ok, type Transition } from "./types.js";

export const CONFIG_REVISION_STATES = [
  "draft",
  "planned",
  "tripwire_held",
  "applying",
  "active",
  "rejected",
  "superseded",
  "rolled_back",
] as const;

/** Union of every state, derived from the single-source states list above. */
export type ConfigRevisionState = (typeof CONFIG_REVISION_STATES)[number];

export const CONFIG_REVISION_TERMINAL_STATES: readonly ConfigRevisionState[] = [
  "rejected",
  "superseded",
  "rolled_back",
];

export type ConfigRevisionEvent =
  /** draft → planned: plan() diff vs active revision, compute hashes. */
  | { type: "PLAN" }
  /** planned → tripwire_held: destructive change (route delete / entitlement removal). */
  | { type: "TRIPWIRE_HELD" }
  /** tripwire_held → planned: approver approves. */
  | { type: "APPROVE" }
  /** planned → applying: apply() precondition base == active. */
  | { type: "APPLY" }
  /** applying → active | rejected (CONFIG_PRECONDITION_FAILED if base moved). */
  | { type: "APPLY_RESULT"; ok: boolean }
  /** active → superseded: next revision applied. */
  | { type: "SUPERSEDE" }
  /** active → rolled_back: republish a prior revision. */
  | { type: "ROLLBACK" };

export function transitionConfigRevision(
  state: ConfigRevisionState,
  event: ConfigRevisionEvent,
): Transition<ConfigRevisionState> {
  switch (state) {
    case "draft":
      if (event.type === "PLAN") return ok("planned");
      return invalidTransition();

    case "planned":
      if (event.type === "TRIPWIRE_HELD") return ok("tripwire_held");
      if (event.type === "APPLY") return ok("applying");
      return invalidTransition();

    case "tripwire_held":
      if (event.type === "APPROVE") return ok("planned");
      return invalidTransition();

    case "applying":
      if (event.type === "APPLY_RESULT") {
        return ok(event.ok ? "active" : "rejected");
      }
      return invalidTransition();

    case "active":
      if (event.type === "SUPERSEDE") return ok("superseded");
      if (event.type === "ROLLBACK") return ok("rolled_back");
      return invalidTransition();

    case "rejected":
    case "superseded":
    case "rolled_back":
      // Terminal — no outgoing transitions.
      return invalidTransition();
  }
}
