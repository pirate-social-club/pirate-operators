// UNRUN. Mount ShellPlayerInput with an actual audio fixture in private export.
import { expect, type Page } from "@playwright/test";
export async function assertCustomPlayerLifecycle(page: Page) {
  const audio = page.locator("[data-song-player] audio");
  await expect(audio).toHaveAttribute("hidden", "");
  await expect(audio).not.toHaveAttribute("controls");
  await expect(
    page.getByRole("button", { name: "Play Fixture song", exact: true }),
  ).toBeVisible();
  const unavailableSlider = page.getByRole("slider");
  await expect(unavailableSlider).toHaveAttribute("data-disabled", "");
  await expect(unavailableSlider).not.toHaveAttribute("tabindex");
  await unavailableSlider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(audio).not.toHaveAttribute("src");
  expect(
    await audio.evaluate((element: HTMLAudioElement) => element.currentTime),
  ).toBe(0);
  await expect(page.locator("[data-song-time]")).toContainText("--:--");
  await page
    .getByRole("button", { name: "Play Fixture song", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause Fixture song", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Pause Fixture song", exact: true })
    .click();
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
    .toBe(true);
  const slider = page.getByRole("slider");
  await slider.focus();
  await slider.press("Home");
  await slider.press("ArrowRight");
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Play Fixture song", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause Fixture song", exact: true }),
  ).toBeVisible();
}
export async function assertFailedAndRetriedSameSource(page: Page) {
  const audio = page.locator("[data-song-player] audio");
  await page
    .getByRole("button", { name: "Play Fixture song", exact: true })
    .click();
  await expect(
    page.getByText("Audio could not be loaded. Retry playback."),
  ).toBeVisible();
  // Harness restores the same URL before this deliberate retry.
  await page
    .getByRole("button", { name: "Retry playback", exact: true })
    .click();
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "Pause Fixture song", exact: true }),
  ).toBeVisible();
}

export async function assertLateGrantNeverCrossesRouteIdentity(page: Page) {
  const oldAudio = await page
    .locator('[data-song-player="fixture-A"] audio')
    .evaluateHandle((element) => element);
  await page
    .getByRole("button", { name: "Play fixture-A", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Fixture navigate B", exact: true })
    .click();
  const b = page.locator('[data-song-player="fixture-B"]');
  await expect(b).toBeVisible();
  await page
    .getByRole("button", { name: "Play fixture-B", exact: true })
    .click();
  await expect(b.locator("audio")).toHaveAttribute("src", /fixture-b\.wav$/);
  await expect(
    page.getByRole("button", { name: "Pause fixture-B", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Fixture resolve A", exact: true })
    .click();
  await expect(b.locator("audio")).toHaveAttribute("src", /fixture-b\.wav$/);
  await oldAudio.evaluate((element) => {
    element.dispatchEvent(new Event("play"));
  });
  await expect
    .poll(() =>
      b
        .locator("audio")
        .evaluate((element: HTMLAudioElement) => element.paused),
    )
    .toBe(false);
  expect(
    await oldAudio.evaluate((element) => element.getAttribute("src")),
  ).toBeNull();
  await page.goBack();
  await expect(
    page.locator('[data-song-player="fixture-A"] audio'),
  ).toHaveAttribute("src", /fixture-a\.wav$/);
  await oldAudio.dispose();
}

export async function assertRenewalAndUnmount(
  page: Page,
  advanceGrantClock: () => Promise<void>,
  unmount: () => Promise<void>,
) {
  const audio = page.locator("[data-song-player] audio");
  await page
    .getByRole("button", { name: "Play Fixture song", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause Fixture song", exact: true }),
  ).toBeVisible();
  const position = await audio.evaluate(
    (element: HTMLAudioElement) => element.currentTime,
  );
  await advanceGrantClock();
  await expect(
    page.getByRole("button", { name: "Pause Fixture song", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeGreaterThanOrEqual(position);
  const retained = await audio.evaluateHandle(
    (element) => element as HTMLAudioElement,
  );
  await unmount();
  await expect(page.locator("[data-song-player]")).toHaveCount(0);
  expect(await retained.evaluate((element) => element.paused)).toBe(true);
  expect(
    await retained.evaluate((element) => element.getAttribute("src")),
  ).toBeNull();
  await retained.dispose();
}

/** Mount fresh ShellPlayerReaderInput with distinct readers and real WAVs. */
export async function assertSamePostReaderIsolation(
  page: Page,
  mode: "replace" | "remount",
) {
  const old = await page
    .locator("[data-song-player] audio")
    .evaluateHandle((element) => element as HTMLAudioElement);
  await page
    .getByRole("button", { name: "Play Fixture same post", exact: true })
    .click();
  if (mode === "remount") {
    await page
      .getByRole("button", { name: "Fixture hide player", exact: true })
      .click();
    await expect(page.locator("[data-song-player]")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Fixture show reader B", exact: true })
      .click();
  } else {
    await page
      .getByRole("button", { name: "Fixture replace reader B", exact: true })
      .click();
  }
  const audio = page.locator("[data-song-player] audio");
  await expect(audio).not.toHaveAttribute("src");
  await page
    .getByRole("button", { name: "Play Fixture same post", exact: true })
    .click();
  await expect(audio).toHaveAttribute("src", /fixture-b\.wav$/);
  await expect(
    page.getByRole("button", { name: "Pause Fixture same post", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Fixture resolve reader A", exact: true })
    .click();
  await old.evaluate((element) => {
    for (const type of [
      "play",
      "playing",
      "waiting",
      "stalled",
      "error",
      "pause",
      "emptied",
      "loadedmetadata",
      "timeupdate",
      "seeked",
    ])
      element.dispatchEvent(new Event(type));
  });
  await expect(audio).toHaveAttribute("src", /fixture-b\.wav$/);
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
    .toBe(false);
  await expect(
    page.getByRole("button", { name: "Pause Fixture same post", exact: true }),
  ).toBeVisible();
  expect(
    await old.evaluate((element) => element.getAttribute("src")),
  ).toBeNull();
  expect(await old.evaluate((element) => element.paused)).toBe(true);
  await expect(page.locator("[data-reader-fixture]")).toHaveAttribute(
    "data-b-calls",
    "1",
  );
  // Late A is reusable only by A. Returning to A does not issue another read.
  await page
    .getByRole("button", { name: "Fixture hide player", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Fixture show reader A", exact: true })
    .click();
  await expect(audio).toHaveAttribute("src", /fixture-a\.wav$/);
  await expect(page.locator("[data-reader-fixture]")).toHaveAttribute(
    "data-a-calls",
    "1",
  );
  await old.dispose();
}

/** bRefuses=true; aImmediate=cachedA. Run both mount modes on fresh fixtures. */
export async function assertSamePostRefusingReader(
  page: Page,
  mode: "replace" | "remount",
  cachedA: boolean,
) {
  await page
    .getByRole("button", { name: "Play Fixture same post", exact: true })
    .click();
  if (cachedA)
    await expect(
      page.getByRole("button", {
        name: "Pause Fixture same post",
        exact: true,
      }),
    ).toBeVisible();
  if (mode === "remount") {
    await page
      .getByRole("button", { name: "Fixture hide player", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Fixture show reader B", exact: true })
      .click();
  } else {
    await page
      .getByRole("button", { name: "Fixture replace reader B", exact: true })
      .click();
  }
  const audio = page.locator("[data-song-player] audio");
  await expect(audio).not.toHaveAttribute("src");
  await page
    .getByRole("button", { name: "Play Fixture same post", exact: true })
    .click();
  await expect(
    page.getByText("This song could not be played. Try again.", {
      exact: true,
    }),
  ).toBeVisible();
  if (!cachedA)
    await page
      .getByRole("button", { name: "Fixture resolve reader A", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Retry playback", exact: true })
    .click();
  await expect(page.locator("[data-reader-fixture]")).toHaveAttribute(
    "data-b-calls",
    "2",
  );
  await expect(audio).not.toHaveAttribute("src");
  await expect(
    page.getByRole("button", { name: "Pause Fixture same post", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Fixture hide player", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Fixture show reader A", exact: true })
    .click();
  await expect(audio).toHaveAttribute("src", /fixture-a\.wav$/);
  await expect(page.locator("[data-reader-fixture]")).toHaveAttribute(
    "data-a-calls",
    "1",
  );
}

/** sameReader=true: a genuine same-context remount still receives late access. */
export async function assertSameReaderLateRemount(page: Page) {
  await page
    .getByRole("button", { name: "Play Fixture same post", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Fixture hide player", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Fixture show reader B", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Fixture resolve reader A", exact: true })
    .click();
  const audio = page.locator("[data-song-player] audio");
  await expect(audio).toHaveAttribute("src", /fixture-a\.wav$/);
  await page
    .getByRole("button", { name: "Play Fixture same post", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause Fixture same post", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-reader-fixture]")).toHaveAttribute(
    "data-a-calls",
    "1",
  );
  await expect(page.locator("[data-reader-fixture]")).toHaveAttribute(
    "data-b-calls",
    "0",
  );
}
