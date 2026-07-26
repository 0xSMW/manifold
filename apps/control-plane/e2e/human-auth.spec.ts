import AxeBuilder from "@axe-core/playwright";
import type { Page, Request, Route } from "@playwright/test";
import { test, expect } from "./fixtures";

const csrf = "csrf-test-value";
const expiresAt = "2026-08-01T08:00:00.000Z";
type SessionFixture = { id: string; status: "active" | "revoked"; current: boolean; createdAt: string; lastSeenAt: string | null; expiresAt: string; revokedAt: string | null };
type ServiceAccountFixture = { id: string; name: string; status: "active" | "disabled"; createdAt: string; disabledAt: string | null; lastUsedAt: string | null };

function body(request: Request) {
  return JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
}

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

function expectCsrf(request: Request) {
  expect(request.headers()["x-manifold-csrf"]).toBe(csrf);
  expect(request.headers()["idempotency-key"]).toBeTruthy();
}

async function setCsrfCookie(page: Page) {
  await page.context().addCookies([{ name: "manifold_csrf", value: csrf, url: "http://127.0.0.1:3100" }]);
}

test("activation checks state, requests a generic setup link, and completes without retaining the password", async ({ consolePage: page }) => {
  await setCsrfCookie(page);
  let requested = false;
  await page.route("**/api/v1/auth/activation/status", (route) => json(route, { required: true, configured: false }));
  await page.route("**/api/v1/auth/activation/request", (route) => {
    expectCsrf(route.request());
    expect(body(route.request())).toEqual({ email: "owner@example.test" });
    requested = true;
    return json(route, {});
  });
  await page.route("**/api/v1/auth/activation/complete", (route) => {
    expectCsrf(route.request());
    expect(body(route.request())).toEqual({ token: "setup-token", name: "Olivia Owner", password: "a-safe-password" });
    return json(route, {});
  });

  await page.goto("/activate");
  await expect(page.getByRole("heading", { name: "Set up Manifold" })).toBeVisible();
  await page.getByLabel("Owner email").fill("owner@example.test");
  await page.getByRole("button", { name: "Email setup link" }).click();
  await expect(page.getByRole("status")).toContainText("If activation is available");
  expect(requested).toBeTruthy();

  await page.goto("/activate?token=setup-token");
  await page.getByLabel("Your name").fill("Olivia Owner");
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("a-safe-password");
  await page.getByLabel("Confirm password").fill("different-password");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.locator(".auth-notice")).toHaveText("Passwords do not match.");
  await page.getByLabel("Confirm password").fill("a-safe-password");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("a-safe-password", { exact: true })).toHaveCount(0);
});

test("email-password login rejects unsafe next targets, reports errors, and clears the password after a safe navigation", async ({ consolePage: page }) => {
  await setCsrfCookie(page);
  await page.route("**/api/v1/auth/login", (route) => {
    expectCsrf(route.request());
    const credentials = body(route.request());
    if (credentials.password === "wrong-password") {
      return json(route, { error: { code: "UNAUTHENTICATED", message: "Email or password is incorrect.", reason_codes: [], request_id: "fixture", schema: "2026-07-01", retryable: false } }, 401);
    }
    expect(credentials).toEqual({ email: "owner@example.test", password: "a-safe-password" });
    return json(route, {});
  });

  await page.goto("/login?next=https%3A%2F%2Fevil.example");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".auth-notice")).toHaveText("Email or password is incorrect.");
  await page.getByLabel("Password").fill("a-safe-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("a-safe-password", { exact: true })).toHaveCount(0);

  await page.goto("/login?next=%2Fsettings");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("a-safe-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

test("forgot and reset password keep the recovery response generic and return to sign in", async ({ consolePage: page }) => {
  await setCsrfCookie(page);
  await page.route("**/api/v1/auth/password/forgot", (route) => {
    expectCsrf(route.request());
    expect(body(route.request())).toEqual({ email: "unknown@example.test" });
    return json(route, {});
  });
  await page.route("**/api/v1/auth/password/reset", (route) => {
    expectCsrf(route.request());
    expect(body(route.request())).toEqual({ token: "reset-token", password: "a-reset-password" });
    return json(route, {});
  });

  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("unknown@example.test");
  await page.getByRole("button", { name: "Email reset link" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email for a password reset link");

  await page.goto("/reset-password?token=reset-token");
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("a-reset-password");
  await page.getByLabel("Confirm password").fill("a-reset-password");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("a-reset-password", { exact: true })).toHaveCount(0);
});

test("the actual invitation link inspects and accepts an invitation without exposing its password after entry", async ({ consolePage: page }) => {
  await setCsrfCookie(page);
  await page.route("**/api/v1/auth/invitation/inspect", (route) => {
    expectCsrf(route.request());
    expect(body(route.request())).toEqual({ token: "invite-token" });
    return json(route, { workspace: { name: "Acme" }, email: "invitee@example.test", role: "editor", expiresAt });
  });
  await page.route("**/api/v1/auth/invitation/accept", (route) => {
    expectCsrf(route.request());
    expect(body(route.request())).toEqual({ token: "invite-token", name: "Ivy Invitee", password: "a-safe-password" });
    return json(route, {});
  });

  await page.goto("/invite/invite-token");
  await expect(page.getByText("Acme", { exact: true })).toBeVisible();
  await expect(page.getByText("invitee@example.test", { exact: true })).toBeVisible();
  await page.getByLabel("Your name").fill("Ivy Invitee");
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("a-safe-password");
  await page.getByLabel("Confirm password").fill("a-safe-password");
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("a-safe-password", { exact: true })).toHaveCount(0);
});

test("authenticated settings actions use CSRF, maintain invitation/session/service-account state, and logout", async ({ consolePage: page }) => {
  await setCsrfCookie(page);
  const invitations = [{ id: "invite-1", email: "pending@example.test", role: "viewer", status: "pending", expiresAt, acceptedAt: null, revokedAt: null, createdAt: expiresAt }];
  const sessions: SessionFixture[] = [
    { id: "session-current", status: "active", current: true, createdAt: expiresAt, lastSeenAt: expiresAt, expiresAt, revokedAt: null },
    { id: "session-other", status: "active", current: false, createdAt: expiresAt, lastSeenAt: expiresAt, expiresAt, revokedAt: null },
  ];
  const serviceAccounts: ServiceAccountFixture[] = [{ id: "service-1", name: "Deploy bot", status: "active", createdAt: expiresAt, disabledAt: null, lastUsedAt: null }];
  await page.route("**/api/v1/settings/invitations**", (route) => {
    const method = route.request().method();
    if (method === "GET") return json(route, { data: invitations, nextCursor: null });
    expectCsrf(route.request());
    if (route.request().url().endsWith("/invitations")) {
      expect(body(route.request())).toEqual({ email: "new@example.test", role: "admin" });
      invitations.push({ id: "invite-2", email: "new@example.test", role: "admin", status: "pending", expiresAt, acceptedAt: null, revokedAt: null, createdAt: expiresAt });
    }
    return json(route, { data: {} }, 201);
  });
  await page.route("**/api/v1/settings/sessions**", (route) => {
    if (route.request().method() === "GET") return json(route, { data: sessions, nextCursor: null });
    expectCsrf(route.request());
    sessions[1] = { ...sessions[1], status: "revoked", revokedAt: expiresAt };
    return json(route, { data: { id: "session-other", status: "revoked" } });
  });
  await page.route("**/api/v1/settings/service-accounts**", (route) => {
    if (route.request().method() === "GET") return json(route, { data: serviceAccounts, nextCursor: null });
    expectCsrf(route.request());
    if (route.request().url().endsWith("/service-accounts/service-1/tokens")) {
      expect(body(route.request())).toEqual({ kind: "serviceAccount", name: "Production deploy", scopes: ["config:read", "routes:write"] });
      return json(route, { data: { id: "token-service-1", displayPrefix: "mf_tok_service", scopes: ["config:read", "routes:write"], expiresAt: null, kind: "serviceAccount", name: "Production deploy", plaintext: "mf_tok_service_visible_once" } }, 201);
    }
    if (route.request().url().endsWith("/service-accounts")) {
      expect(body(route.request())).toEqual({ name: "Release bot" });
      serviceAccounts.push({ id: "service-2", name: "Release bot", status: "active", createdAt: expiresAt, disabledAt: null, lastUsedAt: null });
    } else serviceAccounts[0] = { ...serviceAccounts[0], status: "disabled", disabledAt: expiresAt };
    return json(route, { data: {} }, 201);
  });
  await page.route("**/api/v1/auth/logout", (route) => { expectCsrf(route.request()); return json(route, {}); });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Invitations" }).click();
  await expect(page.getByText("pending@example.test", { exact: true })).toBeVisible();
  await page.getByLabel("Invite email").fill("new@example.test");
  await page.getByLabel("Invite role").selectOption("admin");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("Invitation sent.")).toBeVisible();
  await expect(page.getByText("new@example.test", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.getByRole("cell", { name: /This browser active/ })).toBeVisible();
  await page.getByRole("button", { name: "Log out all other sessions" }).click();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Service accounts" }).click();
  await expect(page.getByText("Deploy bot", { exact: true })).toBeVisible();
  await page.getByLabel("Service account name").fill("Release bot");
  await page.getByRole("button", { name: "Create service account" }).click();
  await expect(page.getByText("Release bot", { exact: true })).toBeVisible();
  const deployBotRow = page.getByRole("row", { name: /Deploy bot.*Create token.*Disable/ });
  await deployBotRow.getByRole("button", { name: "Create token" }).click();
  const mintPanel = page.getByRole("heading", { name: "Create token for Deploy bot" }).locator("..");
  await expect(mintPanel).toBeVisible();
  await mintPanel.getByLabel("Token name").fill("Production deploy");
  await mintPanel.getByLabel("Scopes").fill("config:read, routes:write");
  await mintPanel.getByRole("button", { name: "Create token" }).click();
  const copyOnce = page.getByText("mf_tok_service_visible_once", { exact: true });
  await expect(copyOnce).toBeVisible();
  await expect(page.getByText("Copy this service account token now")).toBeVisible();
  await page.getByRole("button", { name: "I stored it" }).click();
  await expect(copyOnce).toHaveCount(0);
  await deployBotRow.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByText("disabled", { exact: true })).toBeVisible();

  const desktopLogout = page.getByRole("banner").getByRole("button", { name: /Log out$/ });
  if (await desktopLogout.isVisible()) {
    await desktopLogout.click();
  } else {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("complementary", { name: "Main navigation" }).getByRole("button", { name: "Log out" }).click();
  }
  await expect(page).toHaveURL(/\/login$/);
});

test("human-auth forms remain accessible and their narrow layout works on mobile", async ({ consolePage: page }) => {
  await page.route("**/api/v1/auth/activation/status", (route) => json(route, { required: false, configured: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical").map(({ id }) => id)).toEqual([]);
});

test("CLI verification deep links focus its matching pending request", async ({ consolePage: page }) => {
  await page.goto("/settings?cli_auth=ABCD-EFGH");
  await expect(page.getByRole("button", { name: "CLI auth" })).toHaveAttribute("aria-pressed", "true");
  const pending = page.getByRole("row", { name: /ABCD-EFGH.*pending/ });
  await expect(pending).toBeVisible();
  await expect(pending).toBeFocused();
});

test("a viewer can manage personal sessions and find Account navigation on mobile", async ({ viewerPage: page }) => {
  await setCsrfCookie(page);
  const sessions: SessionFixture[] = [
    { id: "viewer-current", status: "active", current: true, createdAt: expiresAt, lastSeenAt: expiresAt, expiresAt, revokedAt: null },
    { id: "viewer-other", status: "active", current: false, createdAt: expiresAt, lastSeenAt: expiresAt, expiresAt, revokedAt: null },
  ];
  await page.route("**/api/v1/settings/sessions**", (route) => {
    if (route.request().method() === "GET") return json(route, { data: sessions, nextCursor: null });
    expectCsrf(route.request());
    sessions[1] = { ...sessions[1], status: "revoked", revokedAt: expiresAt };
    return json(route, { data: { revokedCount: 1 } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await page.getByRole("button", { name: "Log out all other sessions" }).click();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("complementary", { name: "Main navigation" }).getByRole("link", { name: "Account" })).toBeVisible();
});
