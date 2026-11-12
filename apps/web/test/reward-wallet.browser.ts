// Queued accepted-composition cases; simulated ports only, no provider/body acceptance.
import { test, expect } from "@playwright/test";
import {
  walletFixture as fixture,
  walletOrigin as origin,
  recipient,
  count,
  reviewQuoted,
} from "./reward-wallet-owner-browser-helpers.ts";

for (const [name, width, height] of [
  ["desktop", 1440, 1000],
  ["phone", 390, 844],
] as const) {
  test(`accepted WalletPortfolio/WalletHub and ReceiveSheet on ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const errors = await fixture(page);
    await expect(
      page.getByRole("heading", { name: "Wallet", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Assets", exact: true }),
    ).toBeVisible();
    if (width < 600) {
      // Pinned PortfolioStory uses p-5 around the actual composition.
      await expect
        .poll(async () =>
          Math.round(
            (await page
              .getByRole("heading", { name: "Wallet", exact: true })
              .boundingBox())!.x,
          ),
        )
        .toBe(20);
    }
    await expect(
      page.getByRole("heading", { name: "Your wallets", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh balances" }),
    ).toBeVisible();
    await expect(page.getByText(/Pending rewards: \$0.03/)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Lottery winnings" }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`wallet-${name}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Receive", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Receive", exact: true });
    await expect(
      dialog.getByText("0x" + "11".repeat(20), { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("MegaETH testnet address", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Copy address" }),
    ).toBeVisible();
    if (width > 600)
      await expect
        .poll(async () => Math.round((await dialog.boundingBox())!.width))
        .toBe(480);
    else
      await expect
        .poll(async () =>
          Math.abs(
            (await dialog.boundingBox())!.y +
              (await dialog.boundingBox())!.height -
              height,
          ),
        )
        .toBeLessThanOrEqual(1);
    expect(await count(page, "fixture_sends")).toBe(0);
    expect(await count(page, "fixture_guard_calls")).toBe(0);
    await page.screenshot({
      path: test.info().outputPath(`receive-${name}.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}
test("palm return resumes the same intent and source WalletWinnings claims the credit once", async ({
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
    page.getByText("Awaiting payment. Payments are processed daily.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await count(page, "fixture_claims")).toBe(2);
  expect(await count(page, "fixture_intents")).toBe(1);
  await page.reload();
  await expect(
    page.getByText("Awaiting payment. Payments are processed daily.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await count(page, "fixture_claims")).toBe(2);
  expect(errors).toEqual([]);
});
test("confirmed payout is separate from balance, pending zero and no extra claim or Send", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("fixture_claimed", "true");
    localStorage.setItem("fixture_paid", "true");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await fixture(page);
  await expect(
    page.getByText("Sent to your wallet", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Pending rewards: $0.00", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Verify to claim" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await count(page, "fixture_claims")).toBe(0);
  expect(await count(page, "fixture_sends")).toBe(0);
  expect(errors).toEqual([]);
});
test("hosted Send is explicit navigation; reload/history never replays a transfer or creates guarded intent", async ({
  page,
  context,
}) => {
  const errors = await fixture(page);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Send test USDm" });
  await expect(dialog.getByText(/Max reserves a fee allowance/)).toBeVisible();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Continue in MOSS", exact: true })
    .click();
  await expect(
    dialog.getByText(/Check MOSS history for any Send/),
  ).toBeVisible();
  // The status surface is conservative while the SDK chunk is still loading.
  // Observe this explicit dispatch before testing reload/replay behavior.
  await expect.poll(() => count(page, "fixture_sends")).toBe(1);
  expect(await count(page, "fixture_guard_calls")).toBe(0);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("fixture_send_request")!),
    ),
  ).toEqual({ token: "0x" + "33".repeat(20) });
  await page.reload();
  expect(await count(page, "fixture_sends")).toBe(1);
  const other = await context.newPage();
  await fixture(other);
  await other.getByRole("button", { name: "Send", exact: true }).click();
  dialog = other.getByRole("dialog", { name: "Send test USDm" });
  await dialog.getByRole("button", { name: "Open MOSS history" }).click();
  await expect.poll(() => count(page, "fixture_history")).toBe(1);
  expect(await count(page, "fixture_sends")).toBe(1);
  expect(await count(page, "fixture_prepares")).toBe(0);
  expect(errors).toEqual([]);
});
test("changed account closes old Receive and reloads before showing the next identity", async ({
  page,
}) => {
  const errors = await fixture(page);
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Receive" })).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem("fixture_account", "0x" + "22".repeat(20));
    history.replaceState(null, "", "/wallet?claim=credit_0001");
  });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh balances", exact: true })
    .click();
  await expect(page).toHaveURL(origin + "/wallet");
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Receive" });
  await expect(
    dialog.getByText("0x" + "22".repeat(20), { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("0x" + "11".repeat(20), { exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("late clipboard completion cannot mark another identity as copied", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) =>
            Object.assign(window, { releaseCopyOld: resolve }),
          ),
      },
    }),
  );
  const errors = await fixture(page, "receive-switch");
  const dialog = page.getByRole("dialog", { name: "Receive" });
  await dialog.getByRole("button", { name: "Copy address" }).click();
  await page.evaluate(() => dispatchEvent(new Event("fixture-account-switch")));
  await expect(
    dialog.getByText("0x" + "22".repeat(20), { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { releaseCopyOld(): void }).releaseCopyOld(),
  );
  await expect(
    dialog.getByRole("button", { name: "Copy address", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Copied", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("quoted Max reviews exact fee/recipient; reload and explicit retry keep the frozen guard", async ({
  page,
}) => {
  const errors = await fixture(page, "quoted"),
    dialog = await reviewQuoted(page);
  await dialog
    .getByRole("button", { name: "Authorize send", exact: true })
    .click();
  await expect(
    dialog.getByText(/The network is checking this send/),
  ).toBeVisible();
  const before = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("fixture_intent")!).payment.guardNonce,
  );
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fixture_guard_request")!),
  );
  expect(request.maxGasAllowance).toBe("500000000000");
  expect(request.silent).toBe(false);
  expect(request.sponsor).toBe(false);
  expect(request.data).toContain(
    `a9059cbb${recipient.slice(2).padStart(64, "0")}${28000000000000000n.toString(16).padStart(64, "0")}`,
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
  await page
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  await expect(
    page.getByText(
      "This send is confirmed. The test USDm arrived at the recipient.",
    ),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("lost prepare response recovers the server intent before any fresh details or signing", async ({
  page,
}) => {
  await fixture(page, "quoted");
  await page.evaluate(() =>
    localStorage.setItem("fixture_prepare_failure", "true"),
  );
  const dialog = page.getByRole("dialog", { name: "Send test USDm" });
  await dialog.getByLabel("Send to", { exact: true }).fill(recipient);
  await dialog.getByLabel("Amount (test USDm)").fill("0.001");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Authorize send", exact: true })
    .click();
  await expect(dialog.getByText(/Nothing was signed/)).toBeVisible();
  expect(await count(page, "fixture_prepares")).toBe(1);
  await expect(
    dialog.getByRole("button", { name: "Max", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Cancel prepared Send", exact: true })
    .click();
  await dialog.getByRole("button", { name: "New send", exact: true }).click();
  await expect(dialog.getByLabel("Send to", { exact: true })).toHaveValue("");
  expect(await count(page, "fixture_guard_calls")).toBe(0);
});
test("unresolved guarded cancellation signs only the same nonce and no second token transfer", async ({
  page,
}) => {
  await fixture(page, "quoted");
  const dialog = await reviewQuoted(page);
  await dialog
    .getByRole("button", { name: "Authorize send", exact: true })
    .click();
  await expect(
    dialog.getByText(/The network is checking this send/),
  ).toBeVisible();
  const before = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("fixture_intent")!).payment.guardNonce,
  );
  await dialog
    .getByRole("button", { name: "Cancel Send through wallet", exact: true })
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

test("Close confirmation expires independently of another response", async ({
  page,
}) => {
  await page.clock.install();
  const errors = await fixture(page, "operator");
  await page.evaluate(() => dispatchEvent(new Event("fixture-confirm")));
  const close = page.getByRole("button", { name: "Close entries" });
  await expect(close).toBeEnabled();
  await page.clock.runFor(61001);
  await expect(close).toBeDisabled();
  await expect(
    page.getByText("Refresh to check chain confirmation."),
  ).toBeVisible();
  expect(await count(page, "fixture_closes")).toBe(0);
  expect(errors).toEqual([]);
});

test("a stalled operator refresh expires and releases the polling slot", async ({
  page,
}) => {
  await page.clock.install();
  const errors = await fixture(page, "operator-stall");
  const close = page.getByRole("button", { name: "Close entries" });
  await expect(close).toBeEnabled();
  await page.clock.runFor(31001);
  await expect(close).toBeDisabled();
  await page.clock.runFor(16000);
  expect(await count(page, "fixture_operator_reads")).toBeGreaterThanOrEqual(3);
  expect(await count(page, "fixture_closes")).toBe(0);
  expect(errors).toEqual([]);
});
