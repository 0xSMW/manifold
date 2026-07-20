// packages/domain/src/machines/observation.test.ts — SPEC §5.4, §8.3, §13.
import { test } from "node:test";
import { OBSERVATION_TERMINAL_STATES, transitionObservation } from "./observation.js";
import { expectInvalid, expectOk } from "./transitionTestKit.js";

test("every legal transition succeeds", () => {
  expectOk(transitionObservation, "event_appended", { type: "REDUCE" }, "reduced");
  expectOk(transitionObservation, "reduced", { type: "PROJECT" }, "projected");
  expectOk(transitionObservation, "projected", { type: "COMPACT" }, "compacted");
  expectOk(transitionObservation, "compacted", { type: "DELETE" }, "deleted");
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  // Can't skip reduction.
  expectInvalid(transitionObservation, "event_appended", { type: "PROJECT" });
  // Can't compact before projecting.
  expectInvalid(transitionObservation, "reduced", { type: "COMPACT" });
  for (const terminal of OBSERVATION_TERMINAL_STATES) {
    expectInvalid(transitionObservation, terminal, { type: "REDUCE" });
  }
});
