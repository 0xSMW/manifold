// packages/domain/src/machines/types.ts — shared shape for every state machine (SPEC §5.4, §8).
//
// Each machine in this directory is a PURE function `(state, event) -> Transition<State>`.
// Illegal transitions never throw — they return `{ ok: false, code: 'INVALID_TRANSITION' }`,
// the same `ErrorCode` the control-plane API uses (SPEC §0.3, §10.3), so callers can surface
// it verbatim in a `ControlPlaneError`.
import type { ErrorCode } from "@manifold/contracts";

/** The result of attempting a state transition. */
export type Transition<State> =
  | { ok: true; state: State }
  | { ok: false; code: Extract<ErrorCode, "INVALID_TRANSITION"> };

/** Build the (only) failure variant of a `Transition`. */
export function invalidTransition<State>(): Transition<State> {
  return { ok: false, code: "INVALID_TRANSITION" };
}

/** Build the success variant of a `Transition`. */
export function ok<State>(state: State): Transition<State> {
  return { ok: true, state };
}
