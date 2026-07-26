import { createHmac } from "node:crypto";
import { test, expect } from "@playwright/test";
import postgres from "postgres";

const ownerUrl = process.env.E2E_REAL_PG_URL;
const activationToken = process.env.E2E_REAL_ACTIVATION_TOKEN;
const pepper = process.env.MANIFOLD_AUTH_TOKEN_PEPPER;
if (!ownerUrl || !activationToken || !pepper) throw new Error("real-Postgres auth E2E environment is incomplete");

const owner = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
const hash = (value: string) => createHmac("sha256", pepper).update(value, "utf8").digest();
const resetToken = "e2e-password-reset-capability";
const invitationToken = "e2e-invitation-capability";

async function seedResetCapability() {
  await owner`INSERT INTO auth_email_token (id, user_id, purpose, email, keyed_hash, expires_at)
    VALUES ('reset_real_owner', 'usr_real_owner', 'password_reset', 'owner@example.test', ${hash(resetToken)}, now() + interval '1 hour')`;
}

async function seedInvitationCapability() {
  await owner`INSERT INTO member (id, workspace_id, email, role, invited_at, accepted_at)
    VALUES ('mem_real_invitee', 'ws_real_auth', 'invitee@example.test', 'editor', now(), NULL)`;
  await owner`INSERT INTO workspace_invitation (id, workspace_id, member_id, email, role, invited_by, keyed_hash, expires_at)
    VALUES ('invite_real_1', 'ws_real_auth', 'mem_real_invitee', 'invitee@example.test', 'editor', 'mem_real_owner', ${hash(invitationToken)}, now() + interval '1 hour')`;
}

async function browserApi(page: import("@playwright/test").Page, path: string, method: "GET" | "POST" = "GET") {
  return page.evaluate(async ({ path, method }) => {
    const csrfValue = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("manifold_csrf="))?.slice("manifold_csrf=".length);
    const response = await fetch(path, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json", "X-Manifold-CSRF": csrfValue ?? "", "Idempotency-Key": `real-pg-${path}` } : {},
      body: method === "POST" ? "{}" : undefined,
    });
    return { status: response.status, body: await response.json() };
  }, { path, method });
}

test.describe.configure({ mode: "serial" });
test.afterAll(async () => { await owner.end({ timeout: 5 }); });

test("real migration-backed browser auth activates, logs in, resets, invites, lists/revokes a session, and logs out", async ({ page, browser }) => {
  await page.goto(`/activate?token=${encodeURIComponent(activationToken)}`);
  await page.getByLabel("Your name").fill("Real Owner");
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("initial-password-22");
  await page.getByLabel("Confirm password").fill("initial-password-22");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(async () => (await page.context().cookies()).map((cookie) => cookie.name).sort()).toEqual(["manifold_csrf", "manifold_session"]);

  expect((await browserApi(page, "/api/v1/auth/logout", "POST")).status).toBe(200);
  await expect.poll(async () => (await page.context().cookies()).map((cookie) => cookie.name)).not.toContain("manifold_session");
  await page.goto("/login");

  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("initial-password-22");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);

  await seedResetCapability();
  const oldSession = await owner<{ id: string; revoked_at: Date | null }[]>`SELECT id, revoked_at FROM console_session WHERE user_id='usr_real_owner' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  expect(oldSession[0]?.id).toBeTruthy();
  await page.goto(`/reset-password?token=${encodeURIComponent(resetToken)}`);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("replacement-password-22");
  await page.getByLabel("Confirm password").fill("replacement-password-22");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(async () => (await owner<{ revoked: boolean }[]>`SELECT revoked_at IS NOT NULL AS revoked FROM console_session WHERE id=${oldSession[0]!.id}`)[0]?.revoked).toBe(true);

  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("initial-password-22");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".auth-notice")).toContainText("invalid email or password");
  await page.getByLabel("Password").fill("replacement-password-22");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);

  const listed = await browserApi(page, "/api/v1/settings/sessions");
  expect(listed.status).toBe(200);
  const current = (listed.body as { data: Array<{ id: string; current: boolean }> }).data.find((session) => session.current);
  expect(current?.id).toBeTruthy();
  const revoke = await browserApi(page, `/api/v1/settings/sessions/${current!.id}/revoke`, "POST");
  expect(revoke.status).toBe(200);
  await expect.poll(async () => (await owner<{ revoked: boolean }[]>`SELECT revoked_at IS NOT NULL AS revoked FROM console_session WHERE id=${current!.id}`)[0]?.revoked).toBe(true);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);

  await seedInvitationCapability();
  const inviteContext = await browser.newContext();
  const invitePage = await inviteContext.newPage();
  await invitePage.goto(`/invite/${encodeURIComponent(invitationToken)}`);
  await expect(invitePage.getByText("invitee@example.test", { exact: true })).toBeVisible();
  await invitePage.getByLabel("Your name").fill("Real Invitee");
  await invitePage.getByRole("textbox", { name: "Password", exact: true }).fill("invite-password-22");
  await invitePage.getByLabel("Confirm password").fill("invite-password-22");
  await invitePage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitePage).toHaveURL(/\/$/);
  await expect.poll(async () => (await inviteContext.cookies()).map((cookie) => cookie.name).sort()).toEqual(["manifold_csrf", "manifold_session"]);
  await expect.poll(async () => (await owner<{ verified: boolean; accepted: boolean; sessions: number }[]>`SELECT u.email_verified_at IS NOT NULL AS verified, m.accepted_at IS NOT NULL AS accepted, (SELECT count(*)::int FROM console_session s WHERE s.user_id=u.id AND s.revoked_at IS NULL) AS sessions FROM member m JOIN auth_user u ON u.id=m.user_id WHERE m.id='mem_real_invitee'`)[0]).toMatchObject({ verified: true, accepted: true, sessions: 1 });
  await inviteContext.close();
});
