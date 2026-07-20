// packages/domain/src/machines/providerCredential.test.ts — SPEC §5.4, §6.4.
import { test } from "node:test";
import { transitionProviderCredential } from "./providerCredential.js";
import { expectInvalid, expectOk } from "./transitionTestKit.js";

test("every legal transition succeeds", () => {
  expectOk(transitionProviderCredential, "unvalidated", { type: "VALIDATE", ok: true }, "valid");
  expectOk(transitionProviderCredential, "unvalidated", { type: "VALIDATE", ok: false }, "invalid");
  expectOk(transitionProviderCredential, "valid", { type: "INVALIDATE" }, "invalid");
  expectOk(transitionProviderCredential, "invalid", { type: "VALIDATE", ok: true }, "valid"); // valid ⇄ invalid
  expectOk(transitionProviderCredential, "invalid", { type: "VALIDATE", ok: false }, "invalid");
  expectOk(transitionProviderCredential, "valid", { type: "ROTATE" }, "rotating");
  expectOk(transitionProviderCredential, "invalid", { type: "ROTATE" }, "rotating");
  expectOk(transitionProviderCredential, "rotating", { type: "ROTATION_COMPLETE" }, "revoked");
  expectOk(transitionProviderCredential, "valid", { type: "REVOKE" }, "revoked");
  expectOk(transitionProviderCredential, "invalid", { type: "REVOKE" }, "revoked");
  expectOk(transitionProviderCredential, "rotating", { type: "REVOKE" }, "revoked");
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  expectInvalid(transitionProviderCredential, "unvalidated", { type: "ROTATE" });
  expectInvalid(transitionProviderCredential, "unvalidated", { type: "REVOKE" });
  expectInvalid(transitionProviderCredential, "revoked", { type: "VALIDATE", ok: true });
  expectInvalid(transitionProviderCredential, "revoked", { type: "REVOKE" });
});
