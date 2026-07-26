import { test, expect } from "./fixtures";

test("telemetry range and profile stay URL-backed across Overview, Logs, and Usage", async ({ consolePage: page }) => {
  await page.goto("/?range=7d&profile=enterprise_egress");
  await expect(page.getByLabel("Time range")).toHaveValue("7d");
  await expect(page.getByLabel("Telemetry profile")).toHaveValue("enterprise_egress");

  const nav = page.getByRole("complementary", { name: "Main navigation" });
  const menuButton = page.getByRole("button", { name: "Open navigation" });
  if (await menuButton.isVisible()) await menuButton.click();
  await expect(nav.getByRole("link", { name: "Logs" })).toHaveAttribute("href", "/logs?range=7d&profile=enterprise_egress");
  await nav.getByRole("link", { name: "Logs" }).click();
  await expect(page).toHaveURL("/logs?range=7d&profile=enterprise_egress");
  await expect(page.getByLabel("Time range")).toHaveValue("7d");
  await expect(page.getByLabel("Telemetry profile")).toHaveValue("enterprise_egress");

  await page.getByLabel("Time range").selectOption("1h");
  await expect(page).toHaveURL("/logs?range=1h&profile=enterprise_egress");
  if (await menuButton.isVisible()) await menuButton.click();
  await nav.getByRole("link", { name: "Usage" }).click();
  await expect(page).toHaveURL("/usage?range=1h&profile=enterprise_egress");
  await expect(page.getByLabel("Time range")).toHaveValue("1h");
});

test("shell profile selection updates telemetry links and reloads the active screen", async ({ consolePage: page }) => {
  const observationRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/observations?")) observationRequests.push(request.url());
  });
  await page.goto("/logs?range=24h&profile=public_app");
  await expect(page.getByLabel("Request log results")).toBeVisible();
  const desktopProfile = page.getByRole("banner").getByLabel("Ingress profile");
  if (!(await desktopProfile.isVisible())) await page.getByRole("button", { name: "Open navigation" }).click();
  await (await desktopProfile.isVisible() ? desktopProfile : page.getByLabel("Mobile ingress profile")).selectOption("enterprise_egress");
  await expect(page).toHaveURL("/logs?range=24h&profile=enterprise_egress");
  await expect.poll(() => observationRequests.some((url) => new URL(url).searchParams.get("profile") === "enterprise_egress")).toBeTruthy();
});

test("shell defaults to dark without a stored theme", async ({ consolePage: page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
});

test("overview stacks traffic panels on mobile", async ({ consolePage: page }) => {
  test.skip((page.viewportSize()?.width ?? 0) > 760, "mobile-only responsive assertion");
  await page.goto("/");
  const layout = page.locator("[class*=trafficLayout]");
  await expect(layout).toBeVisible();
  await expect.poll(() => layout.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
});
