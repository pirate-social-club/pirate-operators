import { test, expect } from "@playwright/test";
test("operator chooses a fixed namespace, configures HTTPS without delegation and resumes on mobile", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Community name", { exact: true }).fill("Night Garden");
  await page.getByLabel("Deployment ID", { exact: true }).fill("night-garden");
  await expect(
    page.getByLabel("Community TLD", { exact: true }),
  ).toHaveAttribute("required", "");
  await page.getByLabel("Community TLD", { exact: true }).fill("c22");
  await page.getByLabel("Account ID", { exact: true }).fill("a".repeat(32));
  await page
    .getByLabel("workers.dev subdomain", { exact: true })
    .fill("example");
  await page
    .getByLabel("Project UUID", { exact: true })
    .fill("00000000-0000-0000-0000-000000000001");
  await page
    .getByLabel("Secret folder", { exact: true })
    .fill("/communities/night-garden");
  await page.getByRole("button", { name: "Save & continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Connect your providers" }),
  ).toBeVisible();
  await expect(page.getByLabel("OpenAI API key")).toHaveCount(1);
  await expect(page.getByLabel("ACRCloud access key")).toHaveCount(0);
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
  await expect(page.getByLabel("Community TLD", { exact: true })).toHaveValue(
    "c22",
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

test("independent setup guides CLI login and refuses keys before connection", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Community name", { exact: true }).fill("Night Garden");
  await page.getByLabel("Deployment ID", { exact: true }).fill("night-garden");
  await page.getByLabel("Community TLD", { exact: true }).fill("c22");
  await page.getByLabel("Account ID", { exact: true }).fill("a".repeat(32));
  await page
    .getByLabel("workers.dev subdomain", { exact: true })
    .fill("example");
  await page.getByLabel("Environment", { exact: true }).fill("dev");
  await page
    .getByLabel("Project UUID", { exact: true })
    .fill("00000000-0000-0000-0000-000000000001");
  await page
    .getByLabel("Secret folder", { exact: true })
    .fill("/communities/night-garden");
  await page.getByRole("button", { name: "Save & continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Connect Infisical" }),
  ).toBeVisible();
  await expect(
    page.getByText("infisical login --domain https://infisical.invalid", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save to Infisical" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Connect & prepare folder" }).click();
  await expect(page.getByRole("alert")).toContainText("CLI login", {
    timeout: 20_000,
  });
  await expect(
    page.getByRole("button", { name: "Save to Infisical" }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/wizard-infisical-mobile.png",
    fullPage: true,
  });
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});
