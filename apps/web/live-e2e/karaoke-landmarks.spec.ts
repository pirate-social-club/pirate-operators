// UNRUN. Actual built App -> LearningPageMount -> KaraokePage. Reuses the
// account harness's explicit session/SDK simulation; adds only narrow GETs.
// No take, signature, provider connection, recording or scoring is fabricated.
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  accounts,
  expectAccount,
  origin,
  serveAccounts,
} from "./account-fixture.ts";

const unavailable = { name: "Karaoke unavailable", level: 1, exact: true } as const;
const overlay = (page: Page) => page.locator(".live-karaoke-overlay");

async function failureMain(page: Page, description: string) {
  const activity = overlay(page);
  await expect(activity).toBeVisible();
  await expect(
    activity.getByLabel("Karaoke: Fixture song", { exact: true }),
  ).toBeVisible();
  const main = activity.getByRole("main");
  await expect(main).toHaveCount(1);
  await expect(main.getByRole("heading", unavailable)).toBeVisible();
  await expect(main.getByText(description, { exact: true })).toBeVisible();

  // Inspect semantic ancestors of this failure main, not a document-wide main
  // count: an inactive background shell is not this route's page landmark.
  const failure = page.getByRole("main").filter({
    has: page.getByRole("heading", unavailable),
  });
  for (const role of [
    "banner", "complementary", "contentinfo", "form",
    "main", "navigation", "region", "search",
  ] as const) {
    await expect(page.getByRole(role).filter({ has: failure })).toHaveCount(0);
  }
  await expect(main.getByRole("button", { name: "Try Again", exact: true })).toBeEnabled();
  await expect(main.getByRole("button", { name: "Go Home", exact: true })).toBeVisible();
  return main;
}

async function retryByKeyboard(page: Page, main: Locator) {
  const retry = main.getByRole("button", { name: "Try Again", exact: true });
  const home = main.getByRole("button", { name: "Go Home", exact: true });
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(home).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
}

async function expectClosed(page: Page) {
  await expect(overlay(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("sing")).toBe(false);
  await expect(page.locator("#app-content")).toBeFocused();
  await expect(
    page.getByRole("navigation", { name: "Community documents", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".live-karaoke audio")).toHaveCount(0);
}

// A one-second silent PCM asset lets the real audio element preload normally.
// It is a test-only backing asset, never a scored/provider stream or recording.
function silentBacking() {
  const samples = 8000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 1000 },
]) {
  for (const mode of ["empty", "error"] as const) {
    test(`actual App Karaoke ${mode} has an unnested main and keyboard recovery at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const pageErrors: string[] = [];
      const writes: string[] = [];
      const unexpectedKaraoke: string[] = [];
      let walletReads = 0;
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const state = await serveAccounts(page);
      // Existing fixture owns this modeled cookie and genuine random private
      // account ID. This test never asks its simulated wallet to sign/connect.
      state.signedInAs("first");
      const postId = state.firstLesson.song.postId;
      const songPath = `/api/public/posts/${postId}/karaoke`;
      const instrumentalPath = `/api/karaoke/posts/${postId}/instrumental`;
      const songReads: string[] = [];
      const attemptReads: string[] = [];
      let ready = false;
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin !== origin) return;
        if (url.pathname === "/__fixture/wallet") walletReads++;
        if (url.pathname.startsWith("/api/") && request.method() !== "GET") {
          writes.push(`${request.method()} ${url.pathname}`);
        }
        if (
          url.pathname.startsWith("/api/karaoke/") &&
          !["/api/karaoke/attempt", instrumentalPath].includes(url.pathname)
        ) unexpectedKaraoke.push(url.pathname);
      });

      // These are the real source port's endpoints. All other routes retain
      // serveAccounts, including its actual current-session/account checks.
      await page.route(`${origin}${songPath}`, async (route) => {
        const request = route.request();
        expect(request.method()).toBe("GET");
        expect(request.headers()["x-study-account"]).toBe(accounts.first);
        expect(new URL(request.url()).search).toBe("");
        songReads.push(new URL(request.url()).pathname);
        if (!ready && mode === "error") {
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "fixture_song_unavailable" }),
          });
        }
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            lines: ready ? [{
              lineId: `0x${"4".repeat(64)}`,
              ordinal: 0,
              text: "Fixture timing",
              startMs: 0,
              endMs: 800,
              words: [
                { text: "Fixture", startMs: 0, endMs: 400 },
                { text: "timing", startMs: 400, endMs: 800 },
              ],
            }] : [],
            segments: [],
          }),
        });
      });
      await page.route(
        (url) => url.origin === origin && url.pathname === "/api/karaoke/attempt",
        async (route) => {
          const request = route.request();
          expect(request.method()).toBe("GET");
          expect(request.headers()["x-study-account"]).toBe(accounts.first);
          expect(new URL(request.url()).search).toBe(`?postId=${postId}`);
          attemptReads.push(request.url());
          // Explicit canonical empty read, never a ticket/result/proof stub.
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ state: "none" }),
          });
        },
      );
      const backing = silentBacking();
      await page.route(`${origin}${instrumentalPath}`, async (route) => {
        expect(route.request().method()).toBe("GET");
        await route.fulfill({ contentType: "audio/wav", body: backing });
      });

      const url = new URL(state.url);
      url.searchParams.delete("study");
      url.searchParams.set("sing", postId);
      await page.goto(url.href);
      const description = mode === "empty"
        ? "This song does not have scorable lyrics yet."
        : "This step could not complete. Retry the same step.";
      let main = await failureMain(page, description);
      expect(songReads).toEqual([songPath]);
      expect(attemptReads).toEqual([]);
      await expectAccount(page, accounts.first, state.privateIds.first);

      await retryByKeyboard(page, main);
      await expect.poll(() => songReads.length).toBe(2);
      main = await failureMain(page, description);
      expect(songReads).toEqual([songPath, songPath]);
      expect(attemptReads).toEqual([]);

      // Real failure control invokes App.closeStudy and disposes the source
      // page/port; no fake onExit or alternate App entry is injected.
      const home = main.getByRole("button", { name: "Go Home", exact: true });
      await home.focus();
      await expect(home).toBeFocused();
      await page.keyboard.press("Enter");
      await expectClosed(page);

      // Reenter through actual community/song controls, preserving the owner
      // and original post. A still-failing route remains explicitly retryable.
      await page.getByRole("main", { name: "Community feed", exact: true })
        .getByRole("link", { name: "Fixture song", exact: true }).click();
      await expect(
        page.getByRole("navigation", { name: "Song activities", exact: true }),
      ).toBeVisible();
      await page.getByRole("navigation", { name: "Song activities" })
        .getByRole("link", { name: "Karaoke", exact: true }).click();
      main = await failureMain(page, description);
      expect(songReads).toEqual([songPath, songPath, songPath]);
      ready = true;
      await retryByKeyboard(page, main);
      await expect.poll(() => songReads.length).toBe(4);
      await expect(overlay(page).getByRole("heading", unavailable)).toHaveCount(0);
      const practice = overlay(page).getByRole("region", { name: "Fixture song", exact: true });
      await expect(practice).toBeVisible();
      await expect(practice.getByRole("heading", { name: "Fixture song", level: 1, exact: true })).toHaveCount(1);
      await expect(practice.getByLabel("Fixture timing", { exact: true })).toBeVisible();
      await expect(practice.getByRole("button", { name: "Start karaoke", exact: true })).toBeEnabled();
      expect(attemptReads).toEqual([`${origin}/api/karaoke/attempt?postId=${postId}`]);
      expect(new URL(page.url()).searchParams.get("sing")).toBe(postId);
      await expectAccount(page, accounts.first, state.privateIds.first);

      const exit = practice.getByRole("button", { name: "Exit karaoke", exact: true });
      await exit.focus();
      await page.keyboard.press("Enter");
      await expectClosed(page);
      expect(songReads).toEqual([songPath, songPath, songPath, songPath]);
      expect(writes).toEqual([]);
      expect(unexpectedKaraoke).toEqual([]);
      expect(walletReads).toBe(0);
      expect(state.counts).toEqual({ starts: 0, abandons: 0, refusedAccount: 0, foreign: 0 });
      expect(state.lessonsOf("first")).toEqual([state.firstLesson]);
      expect(state.lessonsOf("second")).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }
}
