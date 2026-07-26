import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("capability completion charges the trusted-client limiter before Argon2 hashing", async () => {
  const source = await readFile(new URL("../lib/human-auth.ts", import.meta.url), "utf8");
  for (const name of ["completeActivation", "resetPassword", "acceptInvitation"]) {
    const start = source.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, `${name} exists`);
    const body = source.slice(start, source.indexOf("\n}", start) + 2);
    assert.ok(body.indexOf("chargeAuthCapabilityCompletion") >= 0, `${name} charges limiter`);
    assert.ok(body.indexOf("chargeAuthCapabilityCompletion") < body.indexOf("hashPassword"), `${name} limits before hashPassword`);
  }
});

test("capability limiter is trusted-client global, not action-token keyed", async () => {
  const source = await readFile(new URL("../lib/auth-rate-limit.ts", import.meta.url), "utf8");
  assert.match(source, /chargeAuthCapabilityCompletion/);
  assert.match(source, /trustedClientBoundary\(request\)/);
  assert.match(source, /\$\{kind\}:ip/);
});
