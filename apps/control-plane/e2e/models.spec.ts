import { test, expect } from "./fixtures";

test("models virtualize a thousands-row result while server filters remain cursor-safe", async ({ consolePage: page }) => {
  await page.goto("/models");
  await page.getByLabel("Search models").fill("scale");

  const result = page.getByLabel("Model catalog results");
  await expect(result).toBeVisible();
  await expect(result).toHaveAttribute("data-model-count", "3000");
  await expect(result.getByRole("row")).toHaveCount(16);
  await expect(result.getByRole("link", { name: "Scale model 0000" })).toBeVisible();
  await result.getByRole("link", { name: "Scale model 0000" }).focus();
  await expect(result.getByRole("link", { name: "Scale model 0000" })).toBeFocused();

  await result.evaluate((element) => { element.scrollTop = 126 * 1_500; element.dispatchEvent(new Event("scroll")); });
  await expect(result.getByRole("link", { name: "Scale model 1500" })).toBeVisible();
  await expect.poll(() => result.getByRole("row").count()).toBeLessThan(25);

  await page.getByLabel("Filter family").selectOption("family-1");
  await expect(page).toHaveURL(/\/models/);
  await expect(page.getByText("Scale model 0001", { exact: true })).toBeVisible();
  await expect(page.getByText("Scale model 0000", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Load more models" }).click();
  await expect(page.getByText("100 loaded", { exact: true })).toBeVisible();
  await result.evaluate((element) => { element.scrollTop = 126 * 50; element.dispatchEvent(new Event("scroll")); });
  await expect(page.getByText("Scale model 0151", { exact: true })).toBeVisible();
  await expect.poll(() => result.getByRole("row").count()).toBeLessThan(25);
  await result.getByRole("link", { name: "Scale model 0151" }).press("Enter");
  await expect(page).toHaveURL(/\/models\/offering-0151$/);
});
