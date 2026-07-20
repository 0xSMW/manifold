// packages/domain/src/machines/cliDeviceAuth.test.ts — SPEC §5.4, §8.6.
import { test } from "node:test";
import {
  CLI_DEVICE_AUTH_TERMINAL_STATES,
  transitionCliDeviceAuth,
} from "./cliDeviceAuth.js";
import { expectInvalid, expectOk } from "./transitionTestKit.js";

test("every legal transition succeeds", () => {
  expectOk(transitionCliDeviceAuth, "pending", { type: "APPROVE" }, "approved");
  expectOk(transitionCliDeviceAuth, "pending", { type: "DENY" }, "denied");
  expectOk(transitionCliDeviceAuth, "pending", { type: "EXPIRE" }, "expired");
  expectOk(transitionCliDeviceAuth, "approved", { type: "ISSUE" }, "issued");
  expectOk(transitionCliDeviceAuth, "approved", { type: "EXPIRE" }, "expired");
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  // Re-poll after issued must not re-issue (single-issue guarantee, §8.6).
  expectInvalid(transitionCliDeviceAuth, "issued", { type: "ISSUE" });
  expectInvalid(transitionCliDeviceAuth, "pending", { type: "ISSUE" });
  for (const terminal of CLI_DEVICE_AUTH_TERMINAL_STATES) {
    expectInvalid(transitionCliDeviceAuth, terminal, { type: "APPROVE" });
  }
});
