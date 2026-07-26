import assert from "node:assert/strict";
import test from "node:test";
import { canonicalAuthOrigin, isSameOriginRequest } from "../lib/auth-origin.ts";
import { generateAuthActionToken, hashAuthToken, resolveAuthTokenPepper } from "../lib/auth-secret.ts";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword, verifyPassword } from "../lib/password.ts";
import { verificationOrigin } from "../lib/settings/cli-authorization.ts";

test("passwords are Argon2id hashed and reject wrong credentials", async () => {
  const password = "a password with sufficient length";
  const stored = await hashPassword(password);
  assert.match(stored, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword("a different sufficient password", stored), false);
  assert.equal(await verifyPassword(password, null), false);
});

test("password length is constrained to 12 through 128 characters", async () => {
  await assert.rejects(hashPassword("a".repeat(PASSWORD_MIN_LENGTH - 1)), /between 12 and 128/);
  await assert.rejects(hashPassword("a".repeat(PASSWORD_MAX_LENGTH + 1)), /between 12 and 128/);
  assert.equal(await verifyPassword("short", null), false);
});

test("auth action tokens are opaque and independently peppered", () => {
  const environment = { MANIFOLD_AUTH_TOKEN_PEPPER: "token-pepper" };
  const token = generateAuthActionToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notDeepEqual(token, generateAuthActionToken());
  assert.deepEqual(hashAuthToken("token", environment), hashAuthToken("token", environment));
  assert.notDeepEqual(hashAuthToken("token", environment), hashAuthToken("token", { MANIFOLD_AUTH_TOKEN_PEPPER: "other" }));
});

test("production auth pepper fails closed while development has a separate sentinel", () => {
  assert.throws(() => resolveAuthTokenPepper({ NODE_ENV: "production" }), /MANIFOLD_AUTH_TOKEN_PEPPER/);
  assert.notEqual(resolveAuthTokenPepper({ NODE_ENV: "development" }), "dev-pepper-not-for-production");
});

test("canonical auth origin requires HTTPS in production and protects same-origin requests", () => {
  assert.equal(canonicalAuthOrigin({ NODE_ENV: "production", MANIFOLD_AUTH_ORIGIN: "https://console.example.com" }), "https://console.example.com");
  assert.throws(() => canonicalAuthOrigin({ NODE_ENV: "production", MANIFOLD_AUTH_ORIGIN: "http://console.example.com" }), /HTTPS/);
  assert.throws(() => canonicalAuthOrigin({ MANIFOLD_AUTH_ORIGIN: "https://console.example.com/login" }), /only an origin/);
  const request = new Request("https://console.example.com/api", { headers: { origin: "https://console.example.com" } });
  assert.equal(isSameOriginRequest(request, { MANIFOLD_AUTH_ORIGIN: "https://console.example.com" }), true);
  assert.equal(isSameOriginRequest(new Request("https://console.example.com/api", { headers: { origin: "https://evil.example" } }), { MANIFOLD_AUTH_ORIGIN: "https://console.example.com" }), false);
});

test("production CLI device authorization uses the auth origin unless a valid console override is set", () => {
  assert.equal(verificationOrigin({ NODE_ENV: "production", MANIFOLD_AUTH_ORIGIN: "https://console.example.com" }), "https://console.example.com");
  assert.equal(verificationOrigin({ NODE_ENV: "production", MANIFOLD_AUTH_ORIGIN: "https://console.example.com", MANIFOLD_CONSOLE_ORIGIN: "https://device.example.com" }), "https://device.example.com");
  assert.throws(() => verificationOrigin({ NODE_ENV: "production", MANIFOLD_AUTH_ORIGIN: "https://console.example.com", MANIFOLD_CONSOLE_ORIGIN: "http://device.example.com" }), /MANIFOLD_CONSOLE_ORIGIN/);
  assert.throws(() => verificationOrigin({ NODE_ENV: "production", MANIFOLD_AUTH_ORIGIN: "https://console.example.com", MANIFOLD_CONSOLE_ORIGIN: "https://device.example.com/settings" }), /MANIFOLD_CONSOLE_ORIGIN/);
});
