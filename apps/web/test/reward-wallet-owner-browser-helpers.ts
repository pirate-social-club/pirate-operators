// Source-story host only. Dialogs are queried from document.body, where Modal portals them.
import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

export const walletOrigin = "https://wallet.example",
  recipient = "0x2222222222222222222222222222222222222222";
export async function walletFixture(page: Page, mode = "", scenario = "") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== walletOrigin) {
      await route.abort();
      return;
    }
    const path = new URL(route.request().url()).pathname;
    const file = resolve(
      "../../.local/owner-wallet-verification-cancel-repair-20261111/browser-dist",
      path.startsWith("/app/assets/")
        ? path.slice(1)
        : "reward-wallet.fixture.html",
    );
    const mime: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
    await route.fulfill({
      body: await readFile(file),
      contentType: mime[extname(file)] ?? "text/html",
    });
  });
  await page.goto(
    `${walletOrigin}/wallet${mode ? `?fixture=${mode}${scenario ? `&case=${scenario}` : ""}` : ""}`,
  );
  return errors;
}
export const count = (page: Page, key: string) =>
  page.evaluate((key) => Number(localStorage.getItem(key) ?? "0"), key);
export async function reviewQuoted(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Send test USDm" });
  await dialog.getByLabel("Send to", { exact: true }).fill(recipient);
  await dialog.getByRole("button", { name: "Max", exact: true }).click();
  await expect(dialog.getByLabel("Amount (test USDm)")).toHaveValue("0.028");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Authorize send", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("0.002 USDm reserved")).toBeVisible();
  return dialog;
}
