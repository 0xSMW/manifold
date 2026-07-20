// packages/domain/src/machines/budgetReservation.test.ts — SPEC §5.4, §8.4.
import { test } from "node:test";
import {
  BUDGET_RESERVATION_TERMINAL_STATES,
  transitionBudgetReservation,
} from "./budgetReservation.js";
import { expectInvalid, expectOk } from "./transitionTestKit.js";

test("every legal transition succeeds", () => {
  expectOk(transitionBudgetReservation, "reserved", { type: "COMMIT" }, "committed");
  expectOk(transitionBudgetReservation, "reserved", { type: "ROLLBACK" }, "rolled_back");
  expectOk(transitionBudgetReservation, "reserved", { type: "EXPIRE" }, "expired");
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  for (const terminal of BUDGET_RESERVATION_TERMINAL_STATES) {
    expectInvalid(transitionBudgetReservation, terminal, { type: "COMMIT" });
    expectInvalid(transitionBudgetReservation, terminal, { type: "ROLLBACK" });
    expectInvalid(transitionBudgetReservation, terminal, { type: "EXPIRE" });
  }
});
