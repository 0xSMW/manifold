import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";

test("browser login establishes a session and owner navigation follows profile availability gates", async ({ consolePage: page }) => {
  await page.goto("/login?next=%2F");
  await page.getByLabel("API token").fill("member-token");
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const nav = page.getByRole("complementary", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: "Policies" })).toBeVisible();
  const desktopProfileSelector = page.getByRole("banner").getByLabel("Ingress profile");
  if (!(await desktopProfileSelector.isVisible())) await page.getByRole("button", { name: "Open navigation" }).click();
  const profileSelector = (await desktopProfileSelector.isVisible()) ? desktopProfileSelector : page.getByLabel("Mobile ingress profile");
  await profileSelector.selectOption("enterprise_egress");
  await expect(nav.getByRole("link", { name: "Policies" })).toBeVisible();
  await profileSelector.selectOption("public_app");
  await expect(nav.getByRole("link", { name: "Policies" })).toBeVisible();
});

test("viewer navigation hides mutations and enterprise controls", async ({ viewerPage: page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const nav = page.getByRole("complementary", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: "Logs" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Routes" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Policies" })).toHaveCount(0);
});

test("first run deep links expose the setup sequence", async ({ consolePage: page }) => {
  await page.route("**/api/v1/providers", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [], nextCursor: null }) }));
  await page.route("**/api/v1/routes", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [], nextCursor: null }) }));
  await page.route("**/api/v1/keys", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [], nextCursor: null }) }));
  await page.route("**/api/v1/usage?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [], nextCursor: null }) }));
  await page.route("**/api/v1/observations?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [], next_cursor: null, ingest_lag_seconds: 0 }) }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Send your first request" })).toBeVisible();
  await expect(page.getByRole("link", { name: "1. Add provider" })).toHaveAttribute("href", "/providers");
  await expect(page.getByRole("link", { name: "2. Create route" })).toHaveAttribute("href", "/routes");
  await expect(page.getByRole("link", { name: "3. Publish" })).toHaveAttribute("href", "/publish");
  await expect(page.getByRole("link", { name: "4. Mint key" })).toHaveAttribute("href", "/keys");
});

test("command palette works through keyboard and mobile navigation is usable", async ({ consolePage: page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open command palette" }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.getByLabel("Search pages").fill("logs");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/logs(?:\?|$)/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("complementary", { name: "Main navigation" }).getByRole("link", { name: "Usage" })).toBeVisible();
});

test("shell has no serious automated accessibility violations", async ({ consolePage: page }) => {
  await page.goto("/");
  await expect(page.locator(".shell-root")).toBeVisible();
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((item) => ["critical", "serious"].includes(item.impact ?? ""));
  if (serious.length > 0) console.log(JSON.stringify(serious, null, 2));
  expect(serious.map((item) => item.id)).toEqual([]);
});

test("core shell visual baseline", async ({ consolePage: page }) => {
  await page.goto("/");
  await expect(page.locator(".shell-root")).toHaveScreenshot("overview-shell.png", { animations: "disabled" });
});
