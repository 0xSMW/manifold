// packages/domain/src/machines/virtualKey.test.ts — SPEC §5.4, §8.5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VIRTUAL_KEY_TERMINAL_STATES, transitionVirtualKey } from "./virtualKey.js";

test("every legal transition succeeds", () => {
  assert.deepEqual(transitionVirtualKey("active", { type: "ROTATE" }), {
    ok: true,
    state: "rotating",
  });
  assert.deepEqual(
    transitionVirtualKey("rotating", { type: "GRACE_ELAPSED" }),
    { ok: true, state: "revoked" },
  );
  assert.deepEqual(transitionVirtualKey("active", { type: "REVOKE" }), {
    ok: true,
    state: "revoked",
  });
  assert.deepEqual(transitionVirtualKey("rotating", { type: "REVOKE" }), {
    ok: true,
    state: "revoked",
  });
  assert.deepEqual(transitionVirtualKey("active", { type: "EXPIRE" }), {
    ok: true,
    state: "expired",
  });
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  assert.deepEqual(transitionVirtualKey("rotating", { type: "EXPIRE" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
  assert.deepEqual(transitionVirtualKey("rotating", { type: "ROTATE" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
  for (const terminal of VIRTUAL_KEY_TERMINAL_STATES) {
    assert.deepEqual(transitionVirtualKey(terminal, { type: "ROTATE" }), {
      ok: false,
      code: "INVALID_TRANSITION",
    });
  }
});
