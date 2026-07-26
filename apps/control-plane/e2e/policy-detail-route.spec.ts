import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

test("policy detail has a canonical, refreshable route with simulator and approval access", async ({ consolePage: page }) => {
  await page.goto("/policies");
  await page.getByRole("link", { name: "View", exact: true }).click();
  await expect(page).toHaveURL(/\/policies\/policy-1$/);
  await expect(page.getByRole("heading", { name: "Enterprise egress", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Immutable revision history" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Data-handling constraints (0)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve revision" })).toBeVisible();

  await page.getByRole("button", { name: "Run current revision" }).click();
  await expect(page.getByText("MAX_TOKENS", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Enterprise egress", exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/policies$/);
  await expect(page.getByRole("heading", { name: "Policies", exact: true })).toBeVisible();
});

test("policy detail has accessible loading and not-found recovery states", async ({ consolePage: page }) => {
  await page.route("**/api/v1/policies/missing-policy", (route) => route.fulfill({
    contentType: "application/json",
    status: 404,
    body: JSON.stringify({ error: { code: "NOT_FOUND", message: "policy not found", reason_codes: [], request_id: "fixture", schema: "2026-07-01", retryable: false } }),
  }));
  await page.goto("/policies/missing-policy");
  await expect(page.getByRole("heading", { name: "Policy not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to policies" })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter(({ impact }) => impact === "serious" || impact === "critical");
  expect(violations, violations.map(({ id }) => id).join(", ")).toEqual([]);
});
