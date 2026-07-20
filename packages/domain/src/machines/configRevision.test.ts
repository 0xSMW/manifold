// packages/domain/src/machines/configRevision.test.ts — SPEC §5.4, §8.2.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_REVISION_TERMINAL_STATES,
  transitionConfigRevision,
} from "./configRevision.js";

test("every legal transition succeeds", () => {
  assert.deepEqual(transitionConfigRevision("draft", { type: "PLAN" }), {
    ok: true,
    state: "planned",
  });
  assert.deepEqual(
    transitionConfigRevision("planned", { type: "TRIPWIRE_HELD" }),
    { ok: true, state: "tripwire_held" },
  );
  assert.deepEqual(transitionConfigRevision("planned", { type: "APPLY" }), {
    ok: true,
    state: "applying",
  });
  assert.deepEqual(
    transitionConfigRevision("tripwire_held", { type: "APPROVE" }),
    { ok: true, state: "planned" },
  );
  assert.deepEqual(
    transitionConfigRevision("applying", { type: "APPLY_RESULT", ok: true }),
    { ok: true, state: "active" },
  );
  assert.deepEqual(
    transitionConfigRevision("applying", { type: "APPLY_RESULT", ok: false }),
    { ok: true, state: "rejected" },
  );
  assert.deepEqual(transitionConfigRevision("active", { type: "SUPERSEDE" }), {
    ok: true,
    state: "superseded",
  });
  assert.deepEqual(transitionConfigRevision("active", { type: "ROLLBACK" }), {
    ok: true,
    state: "rolled_back",
  });
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  // Can't apply straight from draft.
  assert.deepEqual(transitionConfigRevision("draft", { type: "APPLY" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
  // Can't approve a tripwire that was never held.
  assert.deepEqual(transitionConfigRevision("planned", { type: "APPROVE" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
  // Can't go straight to active without an apply attempt.
  assert.deepEqual(
    transitionConfigRevision("planned", { type: "APPLY_RESULT", ok: true }),
    { ok: false, code: "INVALID_TRANSITION" },
  );
  for (const terminal of CONFIG_REVISION_TERMINAL_STATES) {
    assert.deepEqual(transitionConfigRevision(terminal, { type: "PLAN" }), {
      ok: false,
      code: "INVALID_TRANSITION",
    });
  }
});
