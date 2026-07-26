import { test, expect } from "./fixtures";

test("provider, route, publish, and copy-once key journey is truthful under deterministic fixtures", async ({ consolePage: page }) => {
  await page.goto("/providers");
  await page.getByRole("main").getByRole("button", { name: "Add credential" }).click();
  const providerDialog = page.getByRole("dialog", { name: "Add provider credential" });
  await providerDialog.getByRole("combobox", { name: "Provider" }).selectOption("openai");
  await providerDialog.getByLabel("Credential label").fill("Production primary");
  await providerDialog.getByLabel("Secret").fill("sk-test-only");
  await providerDialog.getByRole("button", { name: "Add credential" }).click();
  await expect(page.getByText("Production primary")).toBeVisible();

  await page.goto("/routes");
  await page.getByRole("button", { name: "New route" }).click();
  await page.getByLabel("Public name").fill("support");
  await page.getByLabel("Provider credential").selectOption("provider-1");
  await page.getByRole("button", { name: "Create staged route" }).click();
  await expect(page.getByText("Route created as a staged revision")).toBeVisible();

  await page.goto("/publish");
  await expect(page.getByRole("heading", { name: "Publish" })).toBeVisible();

  await page.goto("/keys");
  await page.locator(".console-page-head").getByRole("button", { name: "Mint key" }).click();
  await page.getByRole("dialog", { name: "Mint key" }).getByRole("button", { name: "Mint key" }).click();
  const secret = page.getByRole("dialog", { name: "Copy new key" });
  await expect(secret).toContainText("only time the plaintext key");
  await expect(secret).toContainText("mf_live_visible_once");
  await secret.getByRole("button", { name: "Close key" }).click();
  await expect(page.getByText("mf_live_visible_once")).toHaveCount(0);
});

test("destructive key action requires explicit typed confirmation", async ({ consolePage: page }) => {
  await page.goto("/keys");
  // Seed one active key via mint so the table exposes its destructive action.
  await page.locator(".console-page-head").getByRole("button", { name: "Mint key" }).click();
  await page.getByRole("dialog", { name: "Mint key" }).getByRole("button", { name: "Mint key" }).click();
  await page.getByRole("button", { name: "Close key" }).click();
  await page.getByRole("button", { name: "Revoke key" }).click();
  const dialog = page.getByRole("dialog", { name: "Revoke key" });
  await expect(dialog.getByRole("button", { name: "Revoke key" })).toBeDisabled();
  await dialog.getByLabel(/type .* to confirm/i).fill("mf_live_abc");
  await expect(dialog.getByRole("button", { name: "Revoke key" })).toBeEnabled();
});
