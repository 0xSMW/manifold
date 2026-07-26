import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function expectNoSeriousAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter(({ impact }) => impact === "serious" || impact === "critical");
  expect(violations, violations.map(({ id, nodes }) => `${id}: ${nodes.map((node) => node.target.join(" ")).join(", ")}`).join("\n")).toEqual([]);
}

const screens = [
  ["/", "Overview"],
  ["/routes", "Routes"],
  ["/routes/route-1", "Route"],
  ["/providers", "Providers"],
  ["/providers/provider-1", "Provider credential"],
  ["/keys", "Keys"],
  ["/logs/trace-0000", "Logs"],
  ["/usage", "Usage & Costs"],
  ["/models", "Models"],
  ["/models/offering-0000", "Model"],
  ["/policies", "Policies"],
  ["/budgets/budget-1", "Budget detail"],
  ["/audit", "Audit"],
  ["/deployments/install-1", "Gateway one"],
  ["/storage", "Storage"],
  ["/publish", "Publish"],
  ["/settings", "Settings"],
] as const;

test("every specified desktop and mobile screen renders a deterministic shell without serious accessibility violations", async ({ consolePage: page }, testInfo) => {
  testInfo.setTimeout(120_000);
  for (const [path, heading] of screens) {
    await page.goto(path);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expectNoSeriousAxe(page);
  }
});

test("loading, empty, error, and success states remain user-actionable", async ({ consolePage: page }) => {
  await page.route("**/api/v1/storage", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: "UNAVAILABLE", message: "Storage collector is unavailable" }), status: 503 }));
  await page.goto("/storage");
  await expect(page.getByRole("heading", { name: "Storage" })).toBeVisible();
  await expect(page.getByText("Storage unavailable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.goto("/routes");
  await expect(page.getByText("No routes yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "New route" })).toBeVisible();

  await page.goto("/usage");
  await expect(page.getByRole("img", { name: "Stacked cost chart" })).toBeVisible();
  await expect(page.getByText("Cost over returned buckets")).toBeVisible();
});

test("representative governance, readiness, and device-authorization layouts have visual baselines", async ({ consolePage: page }) => {
  for (const [path, name] of [["/policies", "policies-governance.png"], ["/deployments/install-1", "deployment-readiness.png"]] as const) {
    await page.goto(path);
    await expect(page.locator(".shell-root")).toHaveScreenshot(name, { animations: "disabled" });
  }
  await page.goto("/settings");
  await page.getByRole("button", { name: "CLI auth" }).click();
  await expect(page.getByText("ABCD-EFGH")).toBeVisible();
  await expect(page.locator(".shell-root")).toHaveScreenshot("settings-device-auth.png", { animations: "disabled" });
});

test("policy simulation reports the evaluator outcome", async ({ consolePage: page }) => {
  await page.goto("/policies");
  await page.getByRole("link", { name: "View", exact: true }).click();
  await page.getByRole("button", { name: "Run current revision" }).click();
  await expect(page.getByText("MAX_TOKENS", { exact: true })).toBeVisible();
});
