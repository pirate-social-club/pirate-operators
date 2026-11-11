// Adapted pinned SOURCE transition cases, not reimplemented transitions. Queued; never run by this actor.
// Source: c7cb8783 src/features/wallet/wallet-sponsored-send-sheet.test.tsx and .stories.tsx.
import { test, expect, type Page } from "@playwright/test";
import { walletFixture } from "./reward-wallet-owner-browser-helpers.ts";
import { sourceRecipient } from "./reward-wallet-owner-flow-doubles.ts";

const snapshot = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { walletSourceSnapshot(): Record<string, number> }
    ).walletSourceSnapshot(),
  );
async function review(page: Page, scenario = "") {
  const errors = await walletFixture(page, "source-flow", scenario);
  // Modal portals into body, never #app or the Storybook root.
  const dialog = page.getByRole("dialog", { name: "Send test USDm" });
  await expect(
    dialog.getByText("Wallet balance: 0.03 test USDm"),
  ).toBeVisible();
  await dialog.getByLabel("Send to", { exact: true }).fill(sourceRecipient);
  await dialog.getByLabel("Amount (test USDm)").fill("0.001");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  return { dialog, errors };
}

for (const [name, width, height] of [
  ["desktop", 1440, 1000],
  ["phone", 390, 844],
] as const) {
  test(`source Send review/story double preserves details on ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const { dialog, errors } = await review(page, "review-story");
    await expect(
      dialog.getByText("0.001 test USDm", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(sourceRecipient, { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("MegaETH testnet", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("0.002 USDm reserved", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Covered by Pirate", { exact: true }),
    ).toHaveCount(0);
    await dialog
      .getByRole("button", { name: "Change details", exact: true })
      .click();
    await expect(dialog.getByLabel("Send to", { exact: true })).toHaveValue(
      sourceRecipient,
    );
    await expect(dialog.getByLabel("Amount (test USDm)")).toHaveValue("0.001");
    expect((await snapshot(page)).reserve).toBe(0);
    expect((await snapshot(page)).approve).toBe(0);
    if (width < 600)
      await expect
        .poll(async () =>
          Math.abs(
            (await dialog.boundingBox())!.y +
              (await dialog.boundingBox())!.height -
              height,
          ),
        )
        .toBeLessThanOrEqual(1);
    await page.screenshot({
      path: test.info().outputPath(`source-send-details-${name}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
test("source lost reservation response signs nothing, retains the original recorded intent", async ({
  page,
}) => {
  const { dialog, errors } = await review(page, "reserve-lost");
  await dialog
    .getByRole("button", { name: "Authorize send", exact: true })
    .click();
  await expect(dialog.getByText(/Nothing was signed/)).toBeVisible();
  await expect(
    dialog.getByText("Recorded amount: 0.001 test USDm"),
  ).toBeVisible();
  const calls = await snapshot(page);
  expect(calls.reserve).toBe(1);
  expect(calls.approve).toBe(0);
  expect(calls.submit).toBe(0);
  expect(errors).toEqual([]);
});
test("source uncertain submission is retained through reopening and never signs again automatically", async ({
  page,
}) => {
  const { dialog, errors } = await review(page, "submit-lost");
  await dialog
    .getByRole("button", { name: "Authorize send", exact: true })
    .click();
  await expect(dialog.getByText(/may have reached the network/)).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { unmountOwnerFixture(): void }
    ).unmountOwnerFixture(),
  );
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { reopenOwnerFixture(): void }).reopenOwnerFixture(),
  );
  await expect(
    dialog.getByText(/The network is checking this send/),
  ).toBeVisible();
  const calls = await snapshot(page);
  expect(calls.approve).toBe(1);
  expect(calls.submit).toBe(1);
  expect(calls.reserve).toBe(1);
  expect(errors).toEqual([]);
});
for (const scenario of ["changed", "wrong-chain"]) {
  test(`source ${scenario} server record never reaches signing`, async ({
    page,
  }) => {
    const { dialog, errors } = await review(page, scenario);
    await dialog
      .getByRole("button", { name: "Authorize send", exact: true })
      .click();
    await expect(dialog.getByText(/Nothing was signed/)).toBeVisible();
    const calls = await snapshot(page);
    expect(calls.reserve).toBe(1);
    expect(calls.approve).toBe(0);
    expect(calls.submit).toBe(0);
    expect(errors).toEqual([]);
  });
}
test("source authorization hold does not reserve or sign; explicit sign-in refusal stays held", async ({
  page,
}) => {
  const { dialog, errors } = await review(page, "authorization");
  await expect(
    dialog.getByText(/Your wallet authorization has ended/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  const calls = await snapshot(page);
  expect(calls.reserve).toBe(0);
  expect(calls.approve).toBe(0);
  expect(errors).toEqual([]);
});
test("source close/unmount during restoration disposes wallet and late completion creates no request", async ({
  page,
}) => {
  const errors = await walletFixture(page, "source-flow", "deferred");
  const dialog = page.getByRole("dialog", { name: "Send test USDm" });
  await dialog.getByLabel("Send to", { exact: true }).fill(sourceRecipient);
  await dialog.getByLabel("Amount (test USDm)").fill("0.001");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).restore).toBe(1);
  await page.keyboard.press("Escape"); // Original machine refuses closing while its operation is active.
  expect((await snapshot(page)).close).toBe(0);
  await page.evaluate(() =>
    (
      window as unknown as { unmountOwnerFixture(): void }
    ).unmountOwnerFixture(),
  );
  await page.evaluate(() =>
    (
      window as unknown as { releaseOwnerRestore(): void }
    ).releaseOwnerRestore(),
  );
  await expect.poll(async () => (await snapshot(page)).dispose).toBe(1);
  const calls = await snapshot(page);
  expect(calls.reserve).toBe(0);
  expect(calls.approve).toBe(0);
  expect(calls.submit).toBe(0);
  expect(errors).toEqual([]);
});

test("real MOSS port delegates pointer and keyboard custody to its external wallet surface", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("fixture_moss_focus", "true"),
  );
  const errors = await walletFixture(page);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send test USDm" });
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Continue in MOSS", exact: true })
    .click();
  const native = page.getByRole("button", {
    name: "Simulated MOSS control",
    exact: true,
  });
  await expect(native).toBeFocused();
  await native.click();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("fixture_moss_focused")),
    )
    .toBe("1");
  expect(errors).toEqual([]);
});
