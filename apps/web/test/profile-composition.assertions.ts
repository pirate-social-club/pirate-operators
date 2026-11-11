// UNRUN. Coordinator mounts ProfileCompositionInput in an isolated harness.
import { expect, type Page } from "@playwright/test";
export async function assertEmptyProfile(page: Page) {
  await expect(page.locator("[data-profile-layout]")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Profile", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-profile-layout]")).not.toContainText(
    "private-fixture-account",
  );
  await expect(
    page.getByText("No posts to show.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Settings", exact: true }),
  ).toHaveAttribute("href", "/#/settings");
}
export async function assertProfileReadRetry(page: Page) {
  await expect(page.getByRole("alert")).toHaveText(
    "The profile could not be loaded.",
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("[data-profile-layout]")).toBeVisible();
}
export async function assertSourceLogoutRecovery(page: Page) {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Sign out failed. Please try again.",
  );
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Wallet", exact: true }).click();
  await expect(page.locator("[data-profile-fixture]")).toHaveAttribute(
    "data-last-action",
    "/wallet",
  );
}

export async function assertActivityRetryAndSupportedSettingsOnly(page: Page) {
  await expect(
    page.locator("[data-profile-activity]").getByRole("alert"),
  ).toHaveText("Posts could not be loaded.");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByText("No posts to show.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /delete.*recordings/i }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Telegram connections", { exact: true }),
  ).toHaveCount(0);
}

export async function assertLogoutSurvivesProfileReadFailure(page: Page) {
  await expect(
    page.getByText("Your account could not be checked.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check again", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("[data-profile-fixture]")).toHaveAttribute(
    "data-last-action",
    "logout",
  );
}
