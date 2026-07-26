import { test, expect } from "./fixtures";

test("logs virtualize large result sets, open detail, and export JSONL", async ({ consolePage: page }) => {
  await page.goto("/logs");
  const result = page.getByLabel("Request log results");
  await expect(result).toBeVisible();
  const renderedRows = result.locator("tbody tr");
  await expect.poll(() => renderedRows.count()).toBeGreaterThan(0);
  await expect.poll(() => renderedRows.count()).toBeLessThan(100);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSONL" }).click();
  expect((await download).suggestedFilename()).toBe("manifold-observations.jsonl");
  await result.getByLabel("Open trace trace-0000").click();
  await expect(page.getByRole("dialog", { name: "Trace detail" })).toContainText("trace-0000");
});

test("logs visual baseline", async ({ consolePage: page }) => {
  await page.goto("/logs");
  await expect(page.locator(".shell-root")).toHaveScreenshot("logs-shell.png", { animations: "disabled" });
});
