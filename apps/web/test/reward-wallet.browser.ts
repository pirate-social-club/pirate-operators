// Simulated browser evidence only. No real provider, signer, chain or palm action.
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

const origin = "https://wallet.example",
  recipient = `0x${"22".repeat(20)}`;
async function fixture(page: Page, mode = "") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = resolve(
      "../../.local/wallet-browser-dist",
      path.startsWith("/app/assets/")
        ? path.slice(1)
        : "reward-wallet.fixture.html",
    );
    await route.fulfill({
      body: await readFile(file),
      contentType:
        extname(file) === ".js"
          ? "text/javascript"
          : extname(file) === ".css"
            ? "text/css"
            : "text/html",
    });
  });
  await page.goto(`${origin}/wallet${mode ? `?fixture=${mode}` : ""}`);
  return errors;
}
const count = (page: Page, key: string) =>
  page.evaluate((key) => Number(localStorage.getItem(key) ?? "0"), key);

test("phone wallet separates winnings from spendable balance and Receive shows the exact network/address with no wallet action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await fixture(page);
  await expect(
    page.getByText("Pending rewards: $0.03", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Action needed: verify your palm to claim/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(page.getByAltText("Your wallet address QR code")).toBeVisible();
  await expect(page.getByLabel("Your wallet address")).toHaveValue(
    `0x${"11".repeat(20)}`,
  );
  await expect(
    page.getByText("Receive test USDm on MegaETH testnet (6343)."),
  ).toBeVisible();
  expect(await count(page, "fixture_sends")).toBe(0);
  expect(await count(page, "fixture_guard_calls")).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "../../.local/evidence/wallet-receive-phone.png",
    fullPage: true,
  });
});
test("palm reload resumes the same verification, then claim is accepted without a second verification", async ({
  page,
}) => {
  const errors = await fixture(page);
  await page
    .getByRole("button", { name: "Verify to claim", exact: true })
    .click();
  await expect(
    page.getByAltText("Scan with Very to verify this claim"),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByAltText("Scan with Very to verify this claim"),
  ).toBeVisible();
  expect(await count(page, "fixture_intents")).toBe(1);
  await page.evaluate(() => localStorage.setItem("fixture_verified", "true"));
  await expect(
    page.getByText(/Claim accepted. Waiting for payment/),
  ).toBeVisible();
  expect(await count(page, "fixture_intents")).toBe(1);
  expect(await count(page, "fixture_claims")).toBe(2);
  await page.reload();
  await expect(
    page.getByText(/Claim accepted. Waiting for payment/),
  ).toBeVisible();
  expect(await count(page, "fixture_claims")).toBe(2);
  expect(errors).toEqual([]);
});
test("uncertain hosted Send persists across reload and another tab; opening history never repeats it", async ({
  page,
  context,
}) => {
  const errors = await fixture(page);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Max reserves a fee allowance/)).toBeVisible();
  await page.getByRole("button", { name: "Continue in MOSS" }).click();
  await expect(page.getByText(/Previous Send needs checking/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue in MOSS" }),
  ).toBeDisabled();
  const other = await context.newPage();
  await fixture(other);
  await other.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    other.getByRole("button", { name: "Continue in MOSS" }),
  ).toBeDisabled();
  await other.getByRole("button", { name: "Open MOSS history" }).click();
  await expect.poll(() => count(page, "fixture_history")).toBe(1);
  expect(await count(page, "fixture_sends")).toBe(1);
  expect(errors).toEqual([]);
});
test("quoted Max reviews recipient amount and fee separately; reload/retry retains the frozen guard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await fixture(page, "quoted");
  await page.getByLabel("Recipient wallet address").fill(recipient);
  await page.getByRole("button", { name: "Max", exact: true }).click();
  await expect(
    page.getByText("Recipient receives $0.028 test USDm."),
  ).toBeVisible();
  await expect(page.getByText(/Fee reserve: 0.002 USDm/)).toBeVisible();
  await page.getByRole("button", { name: "Approve Send in wallet" }).click();
  await expect(page.getByText("Send submitted.")).toBeVisible();
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fixture_guard_request")!),
  );
  expect(request.maxGasAllowance).toBe("500000000000");
  expect(request.silent).toBe(false);
  expect(request.sponsor).toBe(false);
  expect(request.data).toContain(
    `a9059cbb${recipient.slice(2).padStart(64, "0")}${28000000000000000n.toString(16).padStart(64, "0")}`,
  );
  const before = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("fixture_intent")!).payment.guardNonce,
  );
  await page.reload();
  await page.getByRole("button", { name: "Review same guarded Send" }).click();
  await expect.poll(() => count(page, "fixture_guard_calls")).toBe(2);
  expect(await count(page, "fixture_prepares")).toBe(1);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("fixture_intent")!).payment.guardNonce,
    ),
  ).toBe(before);
  await page.getByRole("button", { name: "Check Send status" }).click();
  await expect(page.getByText("Send confirmed.")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "../../.local/evidence/wallet-max-phone.png",
    fullPage: true,
  });
});
test("lost prepare response forces recovery of the same server intent before any new quote", async ({
  page,
}) => {
  await fixture(page, "quoted");
  await page.evaluate(() =>
    localStorage.setItem("fixture_prepare_failure", "true"),
  );
  await page.getByLabel("Recipient wallet address").fill(recipient);
  await page.getByLabel("Amount, dollars").fill("0.001");
  await page.getByRole("button", { name: "Review Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Max", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh Send status" }).click();
  await expect(
    page.getByText("Recipient receives $0.001 test USDm."),
  ).toBeVisible();
  expect(await count(page, "fixture_prepares")).toBe(1);
  await page.getByRole("button", { name: "Cancel prepared Send" }).click();
  await expect(
    page.getByRole("button", { name: "Max", exact: true }),
  ).toBeVisible();
  expect(await count(page, "fixture_guard_calls")).toBe(0);
});

test("cancelling an unresolved guarded Send signs only its frozen nonce, without another transfer", async ({
  page,
}) => {
  await fixture(page, "quoted");
  await page.getByLabel("Recipient wallet address").fill(recipient);
  await page.getByRole("button", { name: "Max", exact: true }).click();
  await page.getByRole("button", { name: "Approve Send in wallet" }).click();
  await expect(page.getByText("Send submitted.")).toBeVisible();
  const before = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("fixture_intent")!).payment.guardNonce,
  );
  await page
    .getByRole("button", { name: "Cancel Send through wallet" })
    .click();
  await expect.poll(() => count(page, "fixture_guard_calls")).toBe(2);
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fixture_guard_request")!),
  );
  expect(request.data).toContain(
    `b70e36f0${BigInt(before).toString(16).padStart(64, "0")}`,
  );
  expect(request.data).not.toContain("a9059cbb");
  expect(await count(page, "fixture_prepares")).toBe(1);
});
test("Close entries stays disabled after wall cutoff until safe-head confirmation arrives", async ({
  page,
}) => {
  const errors = await fixture(page, "operator");
  await expect(
    page.getByRole("button", { name: "Close entries" }),
  ).toBeDisabled();
  await expect(
    page.getByText(/Waiting for the chain to confirm the cutoff/),
  ).toBeVisible();
  await page.evaluate(() => dispatchEvent(new Event("fixture-confirm")));
  await expect(
    page.getByRole("button", { name: "Close entries" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Close entries" }).click();
  expect(await count(page, "fixture_closes")).toBe(1);
  expect(errors).toEqual([]);
});
