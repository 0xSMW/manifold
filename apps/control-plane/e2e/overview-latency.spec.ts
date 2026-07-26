import { test, expect } from "./fixtures";

test("Overview renders exact range/profile latency percentiles and keeps empty latency unavailable", async ({ consolePage: page }) => {
  await page.route("**/api/v1/observations/summary?*", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("profile")).toBe("public_app");
    expect(url.searchParams.get("from")).not.toBeNull();
    expect(url.searchParams.get("to")).not.toBeNull();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sample_count: "20", p50_ms: 120, p95_ms: 900 }) });
  });
  await page.goto("/");
  await expect(page.getByText("P50 latency").locator("..")).toContainText("120 ms");
  await expect(page.getByText("P95 latency").locator("..")).toContainText("900 ms");

  await page.route("**/api/v1/observations/summary?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ sample_count: "0", p50_ms: null, p95_ms: null }) }));
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("P50 latency").locator("..")).toContainText("Unavailable");
  await expect(page.getByText("P95 latency").locator("..")).toContainText("Unavailable");
});
