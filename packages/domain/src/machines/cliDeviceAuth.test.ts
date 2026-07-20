// packages/domain/src/machines/cliDeviceAuth.test.ts — SPEC §5.4, §8.6.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLI_DEVICE_AUTH_TERMINAL_STATES,
  transitionCliDeviceAuth,
} from "./cliDeviceAuth.js";

test("every legal transition succeeds", () => {
  assert.deepEqual(transitionCliDeviceAuth("pending", { type: "APPROVE" }), {
    ok: true,
    state: "approved",
  });
  assert.deepEqual(transitionCliDeviceAuth("pending", { type: "DENY" }), {
    ok: true,
    state: "denied",
  });
  assert.deepEqual(transitionCliDeviceAuth("pending", { type: "EXPIRE" }), {
    ok: true,
    state: "expired",
  });
  assert.deepEqual(transitionCliDeviceAuth("approved", { type: "ISSUE" }), {
    ok: true,
    state: "issued",
  });
  assert.deepEqual(transitionCliDeviceAuth("approved", { type: "EXPIRE" }), {
    ok: true,
    state: "expired",
  });
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  // Re-poll after issued must not re-issue (single-issue guarantee, §8.6).
  assert.deepEqual(transitionCliDeviceAuth("issued", { type: "ISSUE" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
  assert.deepEqual(transitionCliDeviceAuth("pending", { type: "ISSUE" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
  for (const terminal of CLI_DEVICE_AUTH_TERMINAL_STATES) {
    assert.deepEqual(transitionCliDeviceAuth(terminal, { type: "APPROVE" }), {
      ok: false,
      code: "INVALID_TRANSITION",
    });
  }
});
