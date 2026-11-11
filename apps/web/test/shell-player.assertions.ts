// UNRUN. Mount ShellPlayerInput with an actual audio fixture in private export.
import { expect, type Page } from "@playwright/test";
export async function assertCustomPlayerLifecycle(page: Page) {
  const audio = page.locator("[data-song-player] audio");
  await expect(audio).toHaveAttribute("hidden", "");
  await expect(audio).not.toHaveAttribute("controls");
  await expect(
    page.getByRole("button", { name: "Play Fixture song", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("slider")).toBeDisabled();
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
