import { expect, test, type Page } from "@playwright/test";
import { karaokeFixtureLines } from "./fixture.ts";

const activeLine = (page: Page) => page.locator(".karaoke-line-active");

/** Token states and the audio clock read in one frame. */
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const audio = document.querySelector("audio")!;
    const line = document.querySelector(".karaoke-line-active");
    return {
      songMs: audio.currentTime * 1000,
      paused: audio.paused,
      line: line?.getAttribute("aria-label") ?? null,
      tokens: [...(line?.querySelectorAll(".karaoke-token") ?? [])].map(
        (token) => ({
          text: token.firstElementChild?.textContent ?? "",
          state: token.getAttribute("data-token-state"),
        }),
      ),
    };
  });

test("words light up in order on the backing track's clock, then results show", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start karaoke" }),
  ).toBeVisible();
  await expect(activeLine(page)).toHaveAttribute("aria-label", "Hello, world!");
  // Provider words carry no punctuation; the canonical line text restores it.
  await expect(activeLine(page).locator(".karaoke-token").first()).toHaveText(
    "Hello, ",
  );

  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect.poll(async () => (await snapshot(page)).paused).toBe(false);

  const seen = new Set<string>();
  let checked = 0;
  while (seen.size < karaokeFixtureLines.length) {
    const s = await snapshot(page);
    const fixture = karaokeFixtureLines.find((l) => l.text === s.line);
    if (fixture && !s.paused) {
      seen.add(fixture.text);
      expect(s.tokens.map((t) => t.text.trim().replace(/[,!]$/, ""))).toEqual(
        fixture.words.map((w) => w.text),
      );
      // The screen samples the clock every 50 ms; allow two samples of slack.
      s.tokens.forEach((token, i) => {
        const word = fixture.words[i];
        if (token.state === "complete")
          expect(word.endMs).toBeLessThanOrEqual(s.songMs + 100);
        if (token.state === "upcoming")
          expect(word.startMs).toBeGreaterThan(s.songMs - 100);
        if (token.state === "active") {
          expect(word.startMs).toBeLessThanOrEqual(s.songMs + 100);
          expect(word.endMs).toBeGreaterThan(s.songMs - 100);
        }
      });
      // A later word never finishes before an earlier one.
      const order = s.tokens.map((t) =>
        ["complete", "active", "upcoming"].indexOf(t.state!),
      );
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      checked++;
    }
    await page.waitForTimeout(40);
  }
  expect(checked).toBeGreaterThan(20);

  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByRole("button", { name: "Sing again" })).toBeVisible();
});

test("a narrow phone keeps short lines on one row", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  const tokens = activeLine(page).locator(".karaoke-token");
  await expect(tokens).toHaveCount(2);
  const [a, b] = [
    await tokens.nth(0).boundingBox(),
    await tokens.nth(1).boundingBox(),
  ];
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(320);
});
