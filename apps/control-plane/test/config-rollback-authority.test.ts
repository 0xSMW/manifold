import assert from "node:assert/strict";
import test from "node:test";
import { mayRollbackConfig } from "../app/api/v1/config/rollback/route.ts";
import type { Principal } from "../lib/auth.ts";

function token(kind: "personal" | "service" | "legacy"): Principal {
  return { workspaceId: "ws_test", actorKind: "api_token", actorId: "tok_test", tokenKind: kind, scopes: ["config:write"] };
}

test("config rollback permits a scoped personal bearer token", () => {
  assert.equal(mayRollbackConfig(token("personal")), true);
});

test("config rollback rejects service and legacy bearer tokens", () => {
  assert.equal(mayRollbackConfig(token("service")), false);
  assert.equal(mayRollbackConfig(token("legacy")), false);
});

test("config rollback keeps the browser admin and owner boundary", () => {
  const browser = (role: string): Principal => ({ workspaceId: "ws_test", actorKind: "member", actorId: "mbr_test", scopes: ["config:write"], member: { id: "mbr_test", email: "person@example.test", name: null, role } });
  assert.equal(mayRollbackConfig(browser("owner")), true);
  assert.equal(mayRollbackConfig(browser("admin")), true);
  assert.equal(mayRollbackConfig(browser("editor")), false);
});
