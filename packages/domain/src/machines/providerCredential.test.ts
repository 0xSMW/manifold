// packages/domain/src/machines/providerCredential.test.ts — SPEC §5.4, §6.4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transitionProviderCredential } from "./providerCredential.js";

test("every legal transition succeeds", () => {
  assert.deepEqual(
    transitionProviderCredential("unvalidated", { type: "VALIDATE", ok: true }),
    { ok: true, state: "valid" },
  );
  assert.deepEqual(
    transitionProviderCredential("unvalidated", { type: "VALIDATE", ok: false }),
    { ok: true, state: "invalid" },
  );
  assert.deepEqual(transitionProviderCredential("valid", { type: "INVALIDATE" }), {
    ok: true,
    state: "invalid",
  });
  assert.deepEqual(
    transitionProviderCredential("invalid", { type: "VALIDATE", ok: true }),
    { ok: true, state: "valid" }, // valid ⇄ invalid
  );
  assert.deepEqual(
    transitionProviderCredential("invalid", { type: "VALIDATE", ok: false }),
    { ok: true, state: "invalid" },
  );
  assert.deepEqual(transitionProviderCredential("valid", { type: "ROTATE" }), {
    ok: true,
    state: "rotating",
  });
  assert.deepEqual(transitionProviderCredential("invalid", { type: "ROTATE" }), {
    ok: true,
    state: "rotating",
  });
  assert.deepEqual(
    transitionProviderCredential("rotating", { type: "ROTATION_COMPLETE" }),
    { ok: true, state: "revoked" },
  );
  assert.deepEqual(transitionProviderCredential("valid", { type: "REVOKE" }), {
    ok: true,
    state: "revoked",
  });
  assert.deepEqual(transitionProviderCredential("invalid", { type: "REVOKE" }), {
    ok: true,
    state: "revoked",
  });
  assert.deepEqual(transitionProviderCredential("rotating", { type: "REVOKE" }), {
    ok: true,
    state: "revoked",
  });
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  assert.deepEqual(transitionProviderCredential("unvalidated", { type: "ROTATE" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
  assert.deepEqual(
    transitionProviderCredential("unvalidated", { type: "REVOKE" }),
    { ok: false, code: "INVALID_TRANSITION" },
  );
  assert.deepEqual(
    transitionProviderCredential("revoked", { type: "VALIDATE", ok: true }),
    { ok: false, code: "INVALID_TRANSITION" },
  );
  assert.deepEqual(transitionProviderCredential("revoked", { type: "REVOKE" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
});
