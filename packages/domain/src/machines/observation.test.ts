// packages/domain/src/machines/observation.test.ts — SPEC §5.4, §8.3, §13.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OBSERVATION_TERMINAL_STATES, transitionObservation } from "./observation.js";

test("every legal transition succeeds", () => {
  assert.deepEqual(transitionObservation("event_appended", { type: "REDUCE" }), {
    ok: true,
    state: "reduced",
  });
  assert.deepEqual(transitionObservation("reduced", { type: "PROJECT" }), {
    ok: true,
    state: "projected",
  });
  assert.deepEqual(transitionObservation("projected", { type: "COMPACT" }), {
    ok: true,
    state: "compacted",
  });
  assert.deepEqual(transitionObservation("compacted", { type: "DELETE" }), {
    ok: true,
    state: "deleted",
  });
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  // Can't skip reduction.
  assert.deepEqual(transitionObservation("event_appended", { type: "PROJECT" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
  // Can't compact before projecting.
  assert.deepEqual(transitionObservation("reduced", { type: "COMPACT" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
  for (const terminal of OBSERVATION_TERMINAL_STATES) {
    assert.deepEqual(transitionObservation(terminal, { type: "REDUCE" }), {
      ok: false,
      code: "INVALID_TRANSITION",
    });
  }
});
