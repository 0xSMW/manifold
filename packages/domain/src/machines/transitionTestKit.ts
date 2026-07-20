// packages/domain/src/machines/transitionTestKit.ts — shared assertions for machine tests.
//
// Every per-machine test repeats the same two shapes: a legal transition must return
// `{ ok: true, state }` and an illegal one `{ ok: false, code: "INVALID_TRANSITION" }`.
// These helpers capture that boilerplate so each machine's test file only lists its
// (from, event) → to edges. Test files stay per-machine (each SPEC §5.4 machine is a
// distinct graph); only the assertion shape is shared — no meta-test over all machines.
import assert from "node:assert/strict";
import type { Transition } from "./types.js";

type Machine<State, Event> = (state: State, event: Event) => Transition<State>;

/** Assert that `transition(from, event)` legally moves the machine to `to`. */
export function expectOk<State, Event>(
  transition: Machine<State, Event>,
  from: State,
  event: Event,
  to: State,
): void {
  assert.deepEqual(transition(from, event), { ok: true, state: to });
}

/** Assert that `transition(from, event)` is rejected as an illegal transition. */
export function expectInvalid<State, Event>(
  transition: Machine<State, Event>,
  from: State,
  event: Event,
): void {
  assert.deepEqual(transition(from, event), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
}
