// packages/domain/src/machines/virtualKey.test.ts — SPEC §5.4, §8.5.
import { test } from "node:test";
import { VIRTUAL_KEY_TERMINAL_STATES, transitionVirtualKey } from "./virtualKey.js";
import { expectInvalid, expectOk } from "./transitionTestKit.js";

test("every legal transition succeeds", () => {
  expectOk(transitionVirtualKey, "active", { type: "ROTATE" }, "rotating");
  expectOk(transitionVirtualKey, "rotating", { type: "GRACE_ELAPSED" }, "revoked");
  expectOk(transitionVirtualKey, "active", { type: "REVOKE" }, "revoked");
  expectOk(transitionVirtualKey, "rotating", { type: "REVOKE" }, "revoked");
  expectOk(transitionVirtualKey, "active", { type: "EXPIRE" }, "expired");
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  expectInvalid(transitionVirtualKey, "rotating", { type: "EXPIRE" });
  expectInvalid(transitionVirtualKey, "rotating", { type: "ROTATE" });
  for (const terminal of VIRTUAL_KEY_TERMINAL_STATES) {
    expectInvalid(transitionVirtualKey, terminal, { type: "ROTATE" });
  }
});
