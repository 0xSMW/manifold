import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml, invitationDeliveryIdempotencyKey, sendAuthEmail } from "../lib/auth-email.ts";

const environment = {
  MANIFOLD_AUTH_ORIGIN: "https://console.example.com",
  RESEND_FROM_EMAIL: "Manifold <auth@example.com>",
  RESEND_API_KEY: "resend-test-secret",
};

test("auth email escapes HTML and posts Resend's exact payload with an idempotency key", async () => {
  let request: Request | undefined;
  await sendAuthEmail({ to: "<person@example.com>", kind: "activation", token: "x&y", expiresAt: "2026-07-27T12:00:00.000Z" }, {
    env: environment,
    idempotencyKey: "manifold-auth-test-key",
    fetch: async (input, init) => { request = new Request(input, init); return new Response(JSON.stringify({ id: "email_1" }), { status: 200 }); },
  });
  assert.ok(request);
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), "Bearer resend-test-secret");
  assert.equal(request.headers.get("idempotency-key"), "manifold-auth-test-key");
  const payload = await request.json() as Record<string, unknown>;
  assert.deepEqual(payload.from, environment.RESEND_FROM_EMAIL);
  assert.deepEqual(payload.to, ["<person@example.com>"]);
  assert.match(String(payload.html), /&lt;person@example\.com&gt;/);
  assert.match(String(payload.html), /https:\/\/console\.example\.com\/activate\?token=x%26y/);
  assert.match(String(payload.text), /activation link expires at 2026-07-27T12:00:00\.000Z/);
  assert.equal(escapeHtml(`<'\"&>`), "&lt;&#39;&quot;&amp;&gt;");
});

test("auth email uses the canonical public invite and reset routes with per-kind copy", async () => {
  const payloads: Record<string, unknown>[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(null, { status: 200 });
  };
  await sendAuthEmail({ to: "invitee@example.com", kind: "invitation", token: "invite-token" }, { env: environment, fetch });
  await sendAuthEmail({ to: "member@example.com", kind: "password-reset", token: "reset-token" }, { env: environment, fetch });
  assert.match(String(payloads[0].subject), /invited/);
  assert.match(String(payloads[0].text), /https:\/\/console\.example\.com\/invite\/invite-token/);
  assert.match(String(payloads[0].text), /invitation link before it expires/);
  assert.match(String(payloads[1].subject), /Reset/);
  assert.match(String(payloads[1].text), /https:\/\/console\.example\.com\/reset-password\?token=reset-token/);
});

test("auth email surfaces Resend failures without disclosing credentials", async () => {
  await assert.rejects(
    sendAuthEmail({ to: "person@example.com", kind: "password-reset", token: "token" }, { env: environment, fetch: async () => new Response("upstream failed", { status: 503 }) }),
    (error: unknown) => error instanceof Error && error.message === "Resend email request failed (503)",
  );
});

test("auth email requires the deployment-standard sender environment variable", async () => {
  await assert.rejects(
    sendAuthEmail({ to: "person@example.com", kind: "activation", token: "token" }, { env: { ...environment, RESEND_FROM_EMAIL: "" } }),
    /RESEND_API_KEY and RESEND_FROM_EMAIL must be set/,
  );
});

test("invitation delivery keys are stable per capability and change when resend rotates it", () => {
  const first = invitationDeliveryIdempotencyKey("inv_1", "first-opaque-token");
  const replay = invitationDeliveryIdempotencyKey("inv_1", "first-opaque-token");
  const resend = invitationDeliveryIdempotencyKey("inv_1", "rotated-opaque-token");
  assert.equal(first, replay, "a guarded replay retains the exact delivery key");
  assert.notEqual(first, resend, "a resend cannot be deduplicated into the old email");
  assert.doesNotMatch(first, /first-opaque-token/);
});
