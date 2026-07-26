import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("identity logout route exists and the console calls its contract path", async () => {
  const [route, consoleGate] = await Promise.all([
    readFile(new URL("../app/api/v1/auth/logout/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/console/console-gate.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /authenticateSession/);
  assert.match(route, /assertSessionMutationSecurity/);
  assert.match(route, /revokeSession/);
  assert.match(route, /clearSessionCookie/);
  assert.match(route, /clearCsrfCookie/);
  assert.match(consoleGate, /\/auth\/logout/);
});
