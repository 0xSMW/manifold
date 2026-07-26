import assert from "node:assert/strict";
import test from "node:test";
import { requireScope, scopesForMemberRole, scopesForRole, type Principal } from "../lib/auth.ts";
import { trustedClientBoundary } from "../lib/auth-rate-limit.ts";

function principal(role: string): Principal {
  return { workspaceId: "ws_test", actorKind: "member", actorId: "mbr_test", scopes: scopesForMemberRole(role), member: { id: "mbr_test", email: "person@example.test", name: null, role } };
}

test("an activated owner session receives config:write", () => {
  assert.doesNotThrow(() => requireScope(principal("owner"), "config:write"));
  assert.doesNotThrow(() => requireScope(principal("admin"), "config:write"));
});

test("a member-bound owner token loses config:write immediately after editor demotion", () => {
  const tokenScopes = ["routes:read", "config:read", "config:write", "keys:write"];
  assert.doesNotThrow(() => requireScope({ workspaceId: "ws_test", actorKind: "api_token", actorId: "tok", scopes: scopesForRole(tokenScopes, "owner") }, "config:write"));
  assert.throws(() => requireScope({ workspaceId: "ws_test", actorKind: "api_token", actorId: "tok", scopes: scopesForRole(tokenScopes, "editor") }, "config:write"));
});

test("invited roles receive their precise session ceilings", () => {
  assert.doesNotThrow(() => requireScope(principal("editor"), "config:read"));
  assert.throws(() => requireScope(principal("editor"), "config:write"));
  assert.doesNotThrow(() => requireScope(principal("viewer"), "routes:read"));
  assert.throws(() => requireScope(principal("viewer"), "routes:write"));
  assert.doesNotThrow(() => requireScope(principal("billing"), "budgets:read"));
  assert.throws(() => requireScope(principal("billing"), "config:read"));
});

test("rate limiting uses a platform client boundary and does not trust generic forwarded headers", () => {
  assert.equal(trustedClientBoundary(new Request("https://console.example.test", { headers: { "x-vercel-forwarded-for": "2001:db8::1", "x-forwarded-for": "203.0.113.9" } })), "2001:db8::1");
  assert.equal(trustedClientBoundary(new Request("https://console.example.test", { headers: { "x-forwarded-for": "203.0.113.9" } })), "unattributed");
});
