// packages/domain/src/machines/configRevision.test.ts — SPEC §5.4, §8.2.
import { test } from "node:test";
import {
  CONFIG_REVISION_TERMINAL_STATES,
  transitionConfigRevision,
} from "./configRevision.js";
import { expectInvalid, expectOk } from "./transitionTestKit.js";

test("every legal transition succeeds", () => {
  expectOk(transitionConfigRevision, "draft", { type: "PLAN" }, "planned");
  expectOk(transitionConfigRevision, "planned", { type: "TRIPWIRE_HELD" }, "tripwire_held");
  expectOk(transitionConfigRevision, "planned", { type: "APPLY" }, "applying");
  expectOk(transitionConfigRevision, "tripwire_held", { type: "APPROVE" }, "planned");
  expectOk(transitionConfigRevision, "applying", { type: "APPLY_RESULT", ok: true }, "active");
  expectOk(transitionConfigRevision, "applying", { type: "APPLY_RESULT", ok: false }, "rejected");
  expectOk(transitionConfigRevision, "active", { type: "SUPERSEDE" }, "superseded");
  expectOk(transitionConfigRevision, "active", { type: "ROLLBACK" }, "rolled_back");
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  // Can't apply straight from draft.
  expectInvalid(transitionConfigRevision, "draft", { type: "APPLY" });
  // Can't approve a tripwire that was never held.
  expectInvalid(transitionConfigRevision, "planned", { type: "APPROVE" });
  // Can't go straight to active without an apply attempt.
  expectInvalid(transitionConfigRevision, "planned", { type: "APPLY_RESULT", ok: true });
  for (const terminal of CONFIG_REVISION_TERMINAL_STATES) {
    expectInvalid(transitionConfigRevision, terminal, { type: "PLAN" });
  }
});
