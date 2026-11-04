import { test, expect } from "@playwright/test";
test("operator configures HTTPS without HNS, reviews responsibilities and resumes on mobile", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Community name", { exact: true }).fill("Night Garden");
  await page.getByLabel("Deployment ID", { exact: true }).fill("night-garden");
  await page.getByLabel("Account ID", { exact: true }).fill("a".repeat(32));
  await page
    .getByLabel("workers.dev subdomain", { exact: true })
    .fill("example");
  await expect(page.getByLabel("Project UUID", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save & continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Your services" }),
  ).toBeVisible();
  await expect(page.getByLabel("OpenAI API key")).toHaveCount(0);
  await page.getByRole("button", { name: "Review deployment" }).click();
  await expect(
    page.getByText("https://pirate-night-garden.example.workers.dev", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Contract responsibilities" }),
  ).toBeVisible();
  await page.getByLabel("I reviewed this account", { exact: false }).check();
  await expect(
    page.getByRole("button", { name: "Deploy infrastructure" }),
  ).toBeDisabled();
  await page.screenshot({
    path: "test-results/wizard-review-desktop.png",
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByLabel("Community name", { exact: true })).toHaveValue(
    "Night Garden",
  );
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Readiness" }).click();
  await expect(
    page.getByRole("heading", { name: "The path to your first song" }),
  ).toBeVisible();
  await expect(page.getByText("not ready", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/wizard-readiness-mobile.png",
    fullPage: true,
  });
});
