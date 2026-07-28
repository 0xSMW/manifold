import type { Route } from "@playwright/test";
import { test, expect } from "./fixtures";

function unavailable(route: Route, message: string) {
  return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message, reason_codes: [], request_id: "fixture", schema: "2026-07-01", retryable: true } }) });
}

test("one failed settings endpoint leaves successful administration sections usable", async ({ consolePage: page }) => {
  await page.route("**/api/v1/settings/teams", (route) => unavailable(route, "Teams service is temporarily unavailable"));

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Workspace details" })).toBeVisible();
  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByRole("button", { name: "Open invitations" })).toBeVisible();
  await page.getByRole("button", { name: "Teams" }).click();
  await expect(page.getByText("Settings section unavailable")).toBeVisible();
  await expect(page.getByText("Teams service is temporarily unavailable")).toBeVisible();
});

test("a failed settings section can be retried without reloading successful sections", async ({ consolePage: page }) => {
  let recover = false;
  let attempts = 0;
  let workspaceAttempts = 0;
  await page.route("**/api/v1/settings/teams", (route) => {
    attempts += 1;
    return !recover ? unavailable(route, "Teams service is temporarily unavailable") : route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [], nextCursor: null }) });
  });
  await page.route("**/api/v1/settings/workspace", async (route) => { workspaceAttempts += 1; await route.fallback(); });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Workspace details" })).toBeVisible();
  await page.getByRole("button", { name: "Teams" }).click();
  await expect(page.getByText("Settings section unavailable")).toBeVisible();
  const attemptsBeforeRetry = attempts;
  const workspaceAttemptsBeforeRetry = workspaceAttempts;
  recover = true;
  await page.getByRole("button", { name: "Retry section" }).click();
  await expect(page.getByRole("button", { name: "Create team", exact: true })).toBeVisible();
  expect(attempts).toBe(attemptsBeforeRetry + 1);
  expect(workspaceAttempts).toBe(workspaceAttemptsBeforeRetry);
  await page.getByRole("button", { name: "Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Workspace details" })).toBeVisible();
});

test("a repeated failed section retry remains rendered without a page error", async ({ consolePage: page }) => {
  let attempts = 0;
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.route("**/api/v1/settings/teams", (route) => { attempts += 1; return unavailable(route, "Teams service is temporarily unavailable"); });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Teams" }).click();
  await expect(page.getByText("Settings section unavailable")).toBeVisible();
  const attemptsBeforeRetry = attempts;
  await page.getByRole("button", { name: "Retry section" }).click();
  await expect.poll(() => attempts).toBeGreaterThan(attemptsBeforeRetry);
  await expect(page.getByText("Settings section unavailable")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("teams and tokens warn when their supporting data is unavailable", async ({ consolePage: page }) => {
  await page.route("**/api/v1/settings/cost-centers", (route) => unavailable(route, "Cost center service is temporarily unavailable"));
  await page.route("**/api/v1/settings/members", (route) => unavailable(route, "Member service is temporarily unavailable"));

  await page.goto("/settings");
  await page.getByRole("button", { name: "Teams" }).click();
  await expect(page.getByText("Cost center data unavailable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create team", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tokens" }).click();
  await expect(page.getByText("Member data unavailable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create personal API token", exact: true })).toBeVisible();
});

test("copy-once token results are shown before an unrelated slow settings refresh", async ({ consolePage: page }) => {
  let delayApps = false;
  let delayedAppRequests = 0;
  await page.route("**/api/v1/settings/apps", async (route) => {
    if (delayApps) { delayedAppRequests += 1; await new Promise((resolve) => setTimeout(resolve, 1_500)); }
    await route.fallback();
  });
  await page.route("**/api/v1/settings/tokens", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { plaintext: "mf_tok_copy_once" } }) });
    await route.fallback();
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Tokens" }).click();
  await expect(page.getByRole("button", { name: "Create personal API token", exact: true })).toBeVisible();
  delayApps = true;
  await page.getByLabel("Token name").fill("Immediate copy");
  await page.getByRole("button", { name: "Create personal API token", exact: true }).click();
  await expect(page.getByText("mf_tok_copy_once", { exact: true })).toBeVisible({ timeout: 500 });
  expect(delayedAppRequests).toBe(0);
});

test("all settings sections load normally when every endpoint succeeds", async ({ consolePage: page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Workspace details" })).toBeVisible();
  await expect(page.getByText("Settings section unavailable")).toHaveCount(0);
  await page.getByRole("button", { name: "Apps" }).click();
  await expect(page.getByRole("button", { name: "Create app", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "CLI auth" }).click();
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
});
