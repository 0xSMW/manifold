import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("runtime auth consumes 0032 human subject, session-version, and CSRF status fields", async () => {
  const source = await readFile(new URL("../lib/auth.ts", import.meta.url), "utf8");
  for (const field of ["token_kind", "token_user_id", "member_role", "member_accepted_at", "user_disabled_at", "service_account_disabled_at", "user_session_version", "session_version", "csrf_hash"]) {
    assert.match(source, new RegExp(`\\b${field}\\b`), `auth runtime must select and enforce ${field}`);
  }
  const tokenLookup = source.match(/SELECT([\s\S]*?)FROM auth_lookup_token/);
  const sessionLookup = source.match(/SELECT([\s\S]*?)FROM auth_lookup_console_session/);
  assert.ok(tokenLookup, "auth runtime must query the token definer seam");
  assert.ok(sessionLookup, "auth runtime must query the session definer seam");
  for (const field of ["token_kind", "token_user_id", "member_role", "member_accepted_at", "service_account_disabled_at"]) assert.match(tokenLookup[1], new RegExp(`\\b${field}\\b`));
  for (const field of ["member_accepted_at", "user_session_version", "session_version", "csrf_hash"]) assert.match(sessionLookup[1], new RegExp(`\\b${field}\\b`));
  for (const reason of ["AUTH_USER_DISABLED", "AUTH_MEMBER_DISABLED", "AUTH_SESSION_REVOKED", "AUTH_SESSION_STALE", "CSRF_INVALID", "AUTH_SERVICE_ACCOUNT_DISABLED"]) {
    assert.match(source, new RegExp(reason), `auth runtime must deny ${reason}`);
  }
});

test("password login maps the database member aliases into the session identity", async () => {
  const source = await readFile(new URL("../lib/human-auth.ts", import.meta.url), "utf8");
  assert.match(source, /member_name:\s*string\s*\|\s*null/);
  assert.match(source, /member_role:\s*string/);
  assert.match(source, /sessionFrom\(\{\s*\.\.\.row,\s*name:\s*row\.member_name,\s*role:\s*row\.member_role\s*\}/);
});
