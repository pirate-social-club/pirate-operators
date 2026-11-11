import { expect, test } from "@playwright/test";
import { sourceFixture } from "./owner-ui-browser-helpers.ts";
import {
  assertCustomPlayerLifecycle,
  assertFailedAndRetriedSameSource,
  assertLateGrantNeverCrossesRouteIdentity,
  assertRenewalAndUnmount,
  assertSamePostReaderIsolation,
  assertSamePostRefusingReader,
  assertSameReaderLateRemount,
} from "./shell-player.assertions.ts";
import {
  assertEmptyProfile,
  assertProfileReadRetry,
  assertSourceLogoutRecovery,
  assertActivityRetryAndSupportedSettingsOnly,
  assertLogoutSurvivesProfileReadFailure,
} from "./profile-composition.assertions.ts";

for (const width of [1440, 390])
  test(`actual custom player decodes, plays, pauses and keyboard-seeks at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const result = await sourceFixture(page, "fixture=player");
    await assertCustomPlayerLifecycle(page);
    await page
      .getByRole("button", { name: "Pause Fixture song", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Play Fixture song", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator("[data-song-player] audio")
          .evaluate((element: HTMLAudioElement) => element.paused),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`player-${width}.png`),
    });
    expect(result).toEqual({ errors: [], unexpected: [] });
  });
test("failed native audio retries the identical source only after explicit Retry", async ({
  page,
}) => {
  const result = await sourceFixture(page, "fixture=player", {
    failFirstAudio: true,
  });
  await assertFailedAndRetriedSameSource(page);
  expect(result).toEqual({ errors: [], unexpected: [] });
});
test("actual expiring grant renews without resetting position and unmount releases media", async ({
  page,
}) => {
  const result = await sourceFixture(page, "fixture=player&mode=renew");
  await assertRenewalAndUnmount(
    page,
    async () => {
      await page
        .getByRole("button", { name: "Fixture advance grant clock" })
        .click();
      await expect(page.locator("[data-grant-reads]")).toHaveAttribute(
        "data-grant-reads",
        "2",
      );
    },
    async () => {
      await page
        .getByRole("button", { name: "Fixture unmount player" })
        .click();
    },
  );
  expect(result).toEqual({ errors: [], unexpected: [] });
});
test("late A grant and native events cannot cross hash/popstate song identity", async ({
  page,
}) => {
  const result = await sourceFixture(page, "fixture=switch");
  await assertLateGrantNeverCrossesRouteIdentity(page);
  expect(result).toEqual({ errors: [], unexpected: [] });
});
for (const mode of ["replace", "remount"] as const) {
  test(`same public post isolates distinct readers during ${mode}`, async ({
    page,
  }) => {
    const result = await sourceFixture(page, "fixture=reader");
    await assertSamePostReaderIsolation(page, mode);
    expect(result).toEqual({ errors: [], unexpected: [] });
  });
  for (const cached of [false, true])
    test(`refusing reader never borrows ${cached ? "cached" : "pending"} A during ${mode}`, async ({
      page,
    }) => {
      const result = await sourceFixture(
        page,
        `fixture=reader&refuse=1&cached=${cached ? 1 : 0}`,
      );
      await assertSamePostRefusingReader(page, mode, cached);
      expect(result).toEqual({ errors: [], unexpected: [] });
    });
}
test("same immutable reader's genuine late remount retains its own grant", async ({
  page,
}) => {
  const result = await sourceFixture(page, "fixture=reader&same=1");
  await assertSameReaderLateRemount(page);
  expect(result).toEqual({ errors: [], unexpected: [] });
});
for (const width of [1440, 390])
  test(`actual empty profile composition at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const result = await sourceFixture(page, "fixture=profile&case=empty");
    await assertEmptyProfile(page);
    await page.screenshot({
      path: test.info().outputPath(`profile-${width}.png`),
    });
    expect(result).toEqual({ errors: [], unexpected: [] });
  });
for (const [scenario, check] of [
  ["read-error", assertProfileReadRetry],
  ["logout-error", assertSourceLogoutRecovery],
  ["activity-error", assertActivityRetryAndSupportedSettingsOnly],
  ["settings-unavailable", assertLogoutSurvivesProfileReadFailure],
] as const)
  test(`actual profile ${scenario} has a working explicit recovery`, async ({
    page,
  }) => {
    const result = await sourceFixture(
      page,
      `fixture=profile&case=${scenario}`,
    );
    await check(page);
    expect(result).toEqual({ errors: [], unexpected: [] });
  });
for (const status of [401, 403, 429])
  test(`actual profile lost ACK and receipt ${status} retains original mutation`, async ({
    page,
  }) => {
    const result = await sourceFixture(
      page,
      `fixture=profile-recovery&status=${status}`,
    );
    const state = page.locator("[data-profile-recovery]");
    await expect(state).toHaveAttribute("data-owner-present", "true");
    await page
      .getByRole("button", { name: "Fixture save", exact: true })
      .click();
    await expect(state).toHaveAttribute("data-mutation", "unknown");
    await page
      .getByRole("button", { name: "Fixture retry receipt", exact: true })
      .click();
    await expect(state).toHaveAttribute("data-receipt-reads", "2");
    await expect(state).toHaveAttribute("data-mutation", "unknown");
    if (status !== 429) {
      await expect(state).toHaveAttribute("data-owner-present", "false");
      await expect(page.locator("[data-profile-layout]")).toHaveCount(0);
    }
    await page
      .getByRole("button", { name: "Fixture attempt new save", exact: true })
      .click();
    await expect(state).toHaveAttribute("data-second-save-blocked", "true");
    await expect(state).toHaveAttribute("data-saves", "1");
    await page
      .getByRole("button", { name: "Fixture restore authority", exact: true })
      .click();
    await expect(state).toHaveAttribute("data-mutation", "idle");
    await expect(state).toHaveAttribute("data-owner-present", "true");
    await expect(state).toHaveAttribute("data-saves", "1");
    await expect(state).toContainText("Fixture profile");
    await expect(state).not.toContainText("private-fixture-account");
    expect(result).toEqual({ errors: [], unexpected: [] });
  });
for (const kind of ["media-storage", "media-host", "media-composer"])
  test(`actual native community ${kind} preserves original scope and source controls`, async ({
    page,
  }) => {
    const result = await sourceFixture(page, `fixture=${kind}`);
    await page
      .getByRole("button", { name: "Run actual community cases" })
      .click();
    await expect(page.locator("[data-community-status]")).toHaveAttribute(
      "data-community-status",
      "passed",
    );
    expect(result).toEqual({ errors: [], unexpected: [] });
  });
test("actual isolated browser Dance storage, immutable File reload and Web Locks", async ({
  page,
}) => {
  const result = await sourceFixture(page, "fixture=dance-storage");
  await page
    .getByRole("button", { name: "Run actual Dance storage cases" })
    .click();
  await expect(page.locator("[data-storage-status]")).toHaveAttribute(
    "data-storage-status",
    "passed",
  );
  expect(result).toEqual({ errors: [], unexpected: [] });
});
