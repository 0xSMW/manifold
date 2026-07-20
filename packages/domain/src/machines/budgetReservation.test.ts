// packages/domain/src/machines/budgetReservation.test.ts — SPEC §5.4, §8.4.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_RESERVATION_TERMINAL_STATES,
  transitionBudgetReservation,
} from "./budgetReservation.js";

test("every legal transition succeeds", () => {
  assert.deepEqual(
    transitionBudgetReservation("reserved", { type: "RECONCILE" }),
    { ok: true, state: "committed" },
  );
  assert.deepEqual(
    transitionBudgetReservation("reserved", { type: "ROLLBACK" }),
    { ok: true, state: "rolled_back" },
  );
  assert.deepEqual(transitionBudgetReservation("reserved", { type: "EXPIRE" }), {
    ok: true,
    state: "expired",
  });
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  for (const terminal of BUDGET_RESERVATION_TERMINAL_STATES) {
    assert.deepEqual(
      transitionBudgetReservation(terminal, { type: "RECONCILE" }),
      { ok: false, code: "INVALID_TRANSITION" },
    );
    assert.deepEqual(
      transitionBudgetReservation(terminal, { type: "ROLLBACK" }),
      { ok: false, code: "INVALID_TRANSITION" },
    );
    assert.deepEqual(transitionBudgetReservation(terminal, { type: "EXPIRE" }), {
      ok: false,
      code: "INVALID_TRANSITION",
    });
  }
});
