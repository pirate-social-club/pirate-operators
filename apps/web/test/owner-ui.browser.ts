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
for (const kind of [
  "media-storage",
  "media-host",
  "media-composer",
  "media-shell",
  "media-shell-profile",
])
  test(`actual native community ${kind} preserves original scope and source controls`, async ({
    page,
  }) => {
    const result = await sourceFixture(page, `fixture=${kind}`);
    await page
      .getByRole("button", { name: "Run actual community cases" })
      .click();
    const outcome = page.locator("[data-community-status]");
    // The aggregate shell journey has six-second internal checks. Preserve
    // its existing whole-test limit rather than preempting it at five seconds.
    await expect(outcome).toHaveAttribute(
      "data-community-status",
      /^(passed|failed)$/,
      { timeout: kind === "media-shell" ? test.info().timeout : 5000 },
    );
    expect(
      await outcome.getAttribute("data-community-status"),
      (await outcome.textContent()) ?? "No fixture diagnostic",
    ).toBe("passed");
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
test("actual native Dance command ordering retains one original through a lost acknowledgement", async ({
  page,
}) => {
  const result = await sourceFixture(page, "fixture=dance-command-ordering");
  await page
    .getByRole("button", { name: "Run actual Dance command ordering" })
    .click();
  await expect(page.locator("[data-storage-status]")).toHaveAttribute(
    "data-storage-status",
    "passed",
  );
  await expect(page.locator("[data-storage-status]")).toContainText(
    '"commandId"',
  );
  expect(result).toEqual({ errors: [], unexpected: [] });
});
test("actual native Dance terminal outcomes recover exact originals across interrupted commits", async ({
  page,
}) => {
  const result = await sourceFixture(page, "fixture=dance-terminal-outcomes");
  await page
    .getByRole("button", { name: "Run actual Dance terminal outcomes" })
    .click();
  await expect(page.locator("[data-storage-status]")).toHaveAttribute(
    "data-storage-status",
    "passed",
  );
  expect(result).toEqual({ errors: [], unexpected: [] });
});

// Additional actual component cases. Existing cases and default config remain intact.
for (const sample of [
  { name: "desktop default", width: 1280, height: 800, browseOnly: false },
  { name: "desktop browse-only", width: 1280, height: 800, browseOnly: true },
  { name: "phone browse-only", width: 390, height: 844, browseOnly: true },
] as const)
  test(`actual Dance Paper ${sample.name} never initializes new posting`, async ({
    page,
  }) => {
    const viewport = { width: sample.width, height: sample.height };
    await page.setViewportSize(viewport);
    const result = await sourceFixture(
      page,
      `fixture=dance-paper-desktop&browseOnly=${sample.browseOnly ? 1 : 0}`,
    );
    await page
      .getByRole("button", {
        name: "Run actual Dance Paper cases",
        exact: true,
      })
      .click();
    const output = page.locator("[data-dance-paper-status]");
    await expect(output).toHaveAttribute("data-dance-paper-status", "passed");
    expect(JSON.parse(await output.innerText())).toMatchObject({
      status: "passed",
      actualViewport: viewport,
      browseOnly: sample.browseOnly,
      reservations: 0,
    });
    expect(
      await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    ).toEqual(viewport);
    expect(result).toEqual({ errors: [], unexpected: [] });
  });
for (const scenario of ["submission", "activation"] as const)
  test(`actual Dance ${scenario} pending boundary becomes browse-only after real resize`, async ({
    page,
  }) => {
    const phone = { width: 390, height: 844 },
      desktop = { width: 1280, height: 800 };
    const resizes: { width: number; height: number }[] = [];
    await page.setViewportSize(phone);
    await page.exposeFunction(
      "__ownerUiDanceResize",
      async (width: number, height: number) => {
        const viewport = { width, height };
        expect([desktop, phone]).toContainEqual(viewport);
        await page.setViewportSize(viewport);
        resizes.push(viewport);
      },
    );
    const result = await sourceFixture(
      page,
      `fixture=dance-async-resize&scenario=${scenario}`,
    );
    await page
      .getByRole("button", {
        name: "Run actual Dance Paper cases",
        exact: true,
      })
      .click();
    const output = page.locator("[data-dance-paper-status]");
    await expect(output).toHaveAttribute("data-dance-paper-status", "passed");
    expect(JSON.parse(await output.innerText())).toMatchObject({
      scenario,
      initial: phone,
      final: desktop,
      freshCommands: 0,
      freshPosts: 0,
      freshNativeCapture: 0,
    });
    expect(resizes).toEqual([desktop, phone]);
    expect(
      await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    ).toEqual(phone);
    expect(page.viewportSize()).toEqual(phone);
    expect(result).toEqual({ errors: [], unexpected: [] });
  });
for (const width of [390, 1280] as const)
  test(`actual Dance missing original preserves recovery and Back exit at ${width}px`, async ({
    page,
  }) => {
    const viewport = { width, height: width === 390 ? 844 : 800 };
    await page.setViewportSize(viewport);
    const result = await sourceFixture(
      page,
      "fixture=dance-missing-original-exit",
    );
    await page
      .getByRole("button", {
        name: "Run actual Dance Paper cases",
        exact: true,
      })
      .click();
    const output = page.locator("[data-dance-paper-status]");
    await expect(output).toHaveAttribute("data-dance-paper-status", "passed");
    expect(JSON.parse(await output.innerText())).toMatchObject({
      exited: true,
      previewCreated: false,
      recaptured: false,
    });
    await expect(page.locator("[data-dance-review]")).toHaveCount(0);
    expect(
      await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    ).toEqual(viewport);
    expect(result).toEqual({ errors: [], unexpected: [] });
  });

// Actual default App -> normal song action -> existing production Dance stack.
for (const scenario of ["private", "legacy", "malformed", "denied", "profile-change"] as const)
  test(`actual normal Dance capability ${scenario} uses its selected owner/profile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const result = await sourceFixture(page, `fixture=dance-private-normal-entry&scenario=${scenario}`);
    await page.getByRole("button", { name: "Run actual private Dance entry", exact: true }).click();
    const output = page.locator("[data-dance-private-entry-status]");
    await expect(output).toHaveAttribute("data-dance-private-entry-status", /^(passed|failed)$/);
    expect(await output.getAttribute("data-dance-private-entry-status"), (await output.textContent()) ?? "No normal entry diagnostic").toBe("passed");
    expect(JSON.parse(await output.innerText())).toMatchObject({
      scenario, defaultEntry: true, publicReviewCalls: 0, cameraOpened: false,
    });
    expect(result).toEqual({ errors: [], unexpected: [] });
  });

for (const sample of [
  { scenario: "private", width: 390 },
  { scenario: "private", width: 1440 },
  { scenario: "lost-ack", width: 390 },
  { scenario: "legacy-v3", width: 390 },
  { scenario: "legacy-v4", width: 390 },
  { scenario: "unknown", width: 390 },
  { scenario: "mode-change", width: 390 },
  { scenario: "pre-acceptance-mode-change", width: 390 },
] as const)
  test(`actual normal Study ${sample.scenario} keeps its publication mode at ${sample.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: sample.width, height: sample.width === 390 ? 844 : 1000 });
    const result = await sourceFixture(page, `fixture=study-private-normal-entry&scenario=${sample.scenario}`);
    await page.getByRole("button", { name: "Run actual private Study entry", exact: true }).click();
    const output = page.locator("[data-study-private-entry-status]");
    await expect(output).toHaveAttribute("data-study-private-entry-status", /^(passed|failed)$/, { timeout: test.info().timeout });
    expect(await output.getAttribute("data-study-private-entry-status"), (await output.textContent()) ?? "No normal Study diagnostic").toBe("passed");
    expect(JSON.parse(await output.innerText())).toMatchObject({
      scenario: sample.scenario, defaultEntry: true, signatures: 0, physicalCaptureRequests: 0,
      enrollmentCalls: sample.scenario === "legacy-v3" || sample.scenario === "unknown" ? 1 : 0,
    });
    expect(result).toEqual({ errors: [], unexpected: [] });
  });
