import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReleaseSummary, positiveInteger } from "../../tools/load/budget-contract.mjs";

test("enterprise budget contract rejects an all-denied run", () => {
  assert.match(evaluateReleaseSummary({ profile: "enterprise_egress", cap: 10, successfulDispatches: 0, budgetDenials: 10 }), /does not equal intended cap/);
});

test("enterprise budget contract requires the intended successes followed by a budget denial", () => {
  assert.equal(evaluateReleaseSummary({ profile: "enterprise_egress", cap: 10, successfulDispatches: 10, budgetDenials: 1 }), null);
  assert.match(evaluateReleaseSummary({ profile: "enterprise_egress", cap: 10, successfulDispatches: 10, budgetDenials: 0 }), /transition missing/);
});

test("hard-budget cap must be a positive safe integer", () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "abc", "9007199254740992"]) assert.throws(() => positiveInteger(value));
  assert.equal(positiveInteger("1"), 1);
});
