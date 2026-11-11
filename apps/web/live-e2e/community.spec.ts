// Explicit HTTP/browser fixtures against the actual built default App.
// Actual SDK/Penpal cases below retain the real pinned transport unchanged.
// No cryptography/D1/provider/device/publication/release acceptance is claimed.
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { serveStudy } from "./study-fixture.ts";
import {
  origin,
  communityId,
  ownerAuthorId,
  catalogAudioPath,
  serveCommunity as serve,
} from "./community-fixture.ts";
import {
  chooseRelease,
  retainedRelease,
  readyStudy,
  noHorizontalOverflow,
} from "./community-controls.ts";

test("fresh anonymous browser loads the real client, offers sign-in and preserves the empty feed on reload", async ({
  page,
}) => {
  await serve(page);
  await page.goto(origin);
  await expect(
    page.getByRole("heading", { name: "Browser Fixture Community" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("No posts in this community yet.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect creator wallet" }),
  ).toHaveCount(0);
  await expect(
    page.locator(`iframe[src^="https://account.megaeth.com"]`),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("No posts in this community yet.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("community-client.png"),
    fullPage: true,
  });
});

test("an existing session can sign out after a reload during a directory outage", async ({
  page,
}) => {
  await serve(page, true, true);
  await page.goto(origin + "/#/account");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.locator(".live-status")).toContainText(
    "temporarily unavailable",
  );
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator(".live-status")).toHaveText("Signed out.");
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("a signed-in learner sees no creator setup or release controls, even on the old wallet return path", async ({
  page,
}) => {
  const state = await serve(page, true);
  await page.goto(
    `${origin}/creator/complete?connection=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa&state=${"s".repeat(43)}`,
  );
  await expect(page.locator("[data-community-page]")).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Profile", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Release a song" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Song title", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/creator wallet/i)).toHaveCount(0);
  await expect(page.getByText(/royalt/i)).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Release a song" }),
  ).toHaveCount(0);
  expect(state.creatorCalls()).toBe(0);
});

test("saved binary and release intent survive an interrupted upload and reload; held/rejected jobs cannot publish", async ({
  page,
}) => {
  const state = await serve(page, true, false, true);
  await page.goto(origin + "/#/publish");
  const composer = page.getByRole("main", {
    name: "Create a post",
    exact: true,
  });
  await expect(
    composer.locator('input[aria-label="Upload audio"]'),
  ).toHaveCount(1);
  await expect(page.getByText(/creator wallet/i)).toHaveCount(0);
  await expect(page.getByText(/royalt/i)).toHaveCount(0);
  await chooseRelease(
    page,
    "Browser saved song",
    "saved-song.mp3",
    "A saved lyric line",
  );
  await expect(composer.getByRole("alert")).toBeVisible();
  expect(state.reservations()).toBe(1);
  expect(state.storedUploads()).toBe(1);
  expect(state.uploadCalls()).toBe(1);
  const original = await retainedRelease(page, state.accountId);
  expect(original).toBeTruthy();
  expect(original!.pending).toBe("audio");
  expect(original!.forbiddenCredentials).toBe(false);
  expect(original!.accountId).toBe(state.accountId);
  expect(original!.accountId).not.toBe(ownerAuthorId);
  expect(original!.communityId).toBe(communityId);
  expect(original!.authorId).toBe(ownerAuthorId);
  expect(original!.body.title).toBe("Browser saved song");
  expect(original!.body.lyrics).toBe("A saved lyric line");
  expect(original!.bodyDigest).toBe(original!.measuredBodyDigest);
  expect(original!.requestId).toBe(state.reservationRequests[0].key);
  expect(original!.bodyDigest).toBe(state.reservationRequests[0].digest);
  expect(JSON.stringify(original!.body)).toBe(
    state.reservationRequests[0].rawBody,
  );
  expect(original!.files).toHaveLength(3);
  for (const file of original!.files) {
    expect(file.nativeFile).toBe(true);
    expect(file.type).toBe("audio/mpeg");
    expect(file.sha256).toBe(
      original!.hashes[file.slot as "audio" | "instrumental" | "vocals"],
    );
  }
  await expect(
    page.getByRole("button", { name: "Start another release", exact: true }),
  ).toHaveCount(0);
  const writesBeforeReload = state.events.filter(
    (event) => event.method !== "GET",
  ).length;
  await page.reload();
  await expect(
    composer.getByRole("button", { name: "Next", exact: true }),
  ).toBeEnabled();
  await expect(composer.getByRole("checkbox")).toBeChecked();
  await expect(
    composer.getByRole("radio", { name: "General", exact: true }),
  ).toBeChecked();
  const restored = await retainedRelease(page, state.accountId);
  expect(restored!.requestId).toBe(original!.requestId);
  expect(restored!.body).toEqual(original!.body);
  expect(restored!.bodyDigest).toBe(original!.bodyDigest);
  expect(restored!.files).toEqual(original!.files);
  expect(restored!.hashes).toEqual(original!.hashes);
  expect(state.events.filter((event) => event.method !== "GET")).toHaveLength(
    writesBeforeReload,
  );
  expect(state.reservations()).toBe(1);
  expect(state.storedUploads()).toBe(1);
  // The current source reconciles the committed master via GET. It must not
  // repeat the older form's second PUT merely to preserve its obsolete count.
  expect(state.uploadCalls()).toBe(1);
  await composer.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    composer.getByRole("button", { name: "Post", exact: true }),
  ).toBeEnabled();
  expect(state.counts.seals).toBe(0); // Ready audio/stems are not a Post receipt.
  await composer.getByRole("button", { name: "Post", exact: true }).click();
  await expect(
    page.locator('[data-posted-song-status="processing"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Processing your song", exact: true }),
  ).toBeVisible();
  expect(state.reservations()).toBe(1);
  expect(state.storedUploads()).toBe(1);
  expect(state.uploadCalls()).toBe(1);
  expect(state.counts.stems).toBe(2);
  expect(state.counts.seals).toBe(1);
  const accepted = await retainedRelease(page, state.accountId);
  expect(accepted!.requestId).toBe(original!.requestId);
  expect(accepted!.bodyDigest).toBe(original!.bodyDigest);
  expect(accepted!.files).toEqual(original!.files);
  expect(accepted!.submissionId).toBe(state.releases()[0].submissionId);
  expect(accepted!.jobId).toBe(state.releases()[0].jobId);
  state.phase("uncertain");
  await page.reload();
  await expect(
    page.locator('[data-posted-song-status="reconciling"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start another release", exact: true }),
  ).toHaveCount(0);
  expect(state.counts.resumes).toBe(0);
  await page
    .getByRole("button", { name: "Check and resume", exact: true })
    .click();
  await expect.poll(() => state.counts.resumes).toBe(1);
  await expect
    .poll(
      async () => (await retainedRelease(page, state.accountId))?.job?.phase,
    )
    .toBe("publication");
  await expect(
    page.locator('[data-posted-song-status="processing"]'),
  ).toBeVisible();
  state.phase("held");
  await page.reload();
  await expect(
    page.locator('[data-posted-song-status="processing_failed"]'),
  ).toBeVisible();
  await expect(
    page.getByText("Nothing was published.", { exact: true }),
  ).toBeVisible();
  expect((await retainedRelease(page, state.accountId))!.job!.errorCode).toBe(
    "fixture_held",
  );
  await expect(
    page.getByRole("button", { name: "Check and resume", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "View song", exact: true }),
  ).toHaveCount(0);
  state.phase("failed");
  await page.reload();
  await expect(
    page.locator('[data-posted-song-status="processing_failed"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Couldn't process this song",
      exact: true,
    }),
  ).toBeVisible();
  expect((await retainedRelease(page, state.accountId))!.job!.errorCode).toBe(
    "fixture_rejected",
  );
  await expect(
    page.getByRole("button", { name: "Check and resume", exact: true }),
  ).toHaveCount(0);
  expect(state.reservations()).toBe(1);
  expect(state.counts.resumes).toBe(1);
  await page
    .getByRole("button", { name: "Start another release", exact: true })
    .click();
  await expect(page.locator("#song-track-title")).toBeEditable();
  expect(await retainedRelease(page, state.accountId)).toBeNull();
  await chooseRelease(
    page,
    "Corrected browser song",
    "corrected.mp3",
    "A corrected saved lyric line",
  );
  await expect(
    composer.getByRole("button", { name: "Post", exact: true }),
  ).toBeEnabled();
  await composer.getByRole("button", { name: "Post", exact: true }).click();
  await expect(
    page.locator('[data-posted-song-status="processing"]'),
  ).toBeVisible();
  expect(state.reservations()).toBe(2);
  expect(state.storedUploads()).toBe(2);
  expect(state.uploadCalls()).toBe(2);
  expect(state.counts.seals).toBe(2);
  const next = await retainedRelease(page, state.accountId);
  expect(next!.requestId).not.toBe(original!.requestId);
  expect(next!.bodyDigest).not.toBe(original!.bodyDigest);
  expect(next!.jobId).not.toBe(accepted!.jobId);
  expect(next!.body.title).toBe("Corrected browser song");
  // Original source status owns the current job, rather than the old form's
  // terminal-history table. The earlier rejection remains in owned server facts.
  const owned = await page.evaluate(async () =>
    (
      await fetch("/api/uploads", {
        credentials: "same-origin",
        cache: "no-store",
      })
    ).json(),
  );
  expect(
    owned.uploads.find(
      (row: { submissionId: string }) =>
        row.submissionId === accepted!.submissionId,
    ).state,
  ).toBe("failed");
  expect(state.releases()[0].phase).toBe("failed");
  state.phase("published");
  state.publishedFacts(false);
  await page.reload();
  await expect(
    page.locator('[data-posted-song-status="reconciling"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Published", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "View song", exact: true }),
  ).toHaveCount(0);
  state.publishedFacts(true);
  await page.reload();
  await expect(
    page.locator('[data-posted-song-status="published"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Published", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View song", exact: true }),
  ).toHaveAttribute("href", `/#song-${next!.postId}`);
  expect(state.counts.proofs).toBeGreaterThan(0);
  expect(
    state.feed().posts.find((row) => row.manifest.postId === next!.postId)
      ?.manifest.title,
  ).toBe(next!.body.title);
  await page
    .getByRole("button", { name: "Start another release", exact: true })
    .click();
  await expect(page.getByLabel("Song title", { exact: true })).toBeEditable();
  await expect(page.getByText(/regist/i)).toHaveCount(0);
  expect(state.creatorCalls()).toBe(0);
  expect(state.reservations()).toBe(2);
  expect(state.counts.resumes).toBe(1);
  await page.screenshot({
    path: test.info().outputPath("upload-recovery.png"),
    fullPage: true,
  });
});

test("desktop uses reference sidebar and community-owned chrome; profile/settings routes stay separate", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await serve(page, true, false, true, "strict-origin", {
    songs: true,
    rewards: true,
  });
  await page.goto(origin);
  const nav = page.getByRole("navigation", {
    name: "Main navigation",
    exact: true,
  });
  await expect(nav).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open navigation", exact: true }),
  ).toHaveCount(0);
  await expect(
    nav.getByRole("link", { name: "Create", exact: true }),
  ).toHaveCount(0);
  await expect(
    nav.getByRole("link", { name: "Release a song", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("group", { name: "Community actions", exact: true })
      .getByRole("button", { name: "Post", exact: true }),
  ).toBeVisible();
  const tabs = page.locator("[data-community-tabs]");
  await expect(
    tabs.getByRole("button", { name: "Feed", exact: true }),
  ).toBeVisible();
  await tabs.getByRole("button", { name: "Songs", exact: true }).click();
  await expect(page.locator("[data-community-post]")).toHaveCount(1);
  await nav.getByRole("link", { name: "Your Songs", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your songs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Song history is coming soon" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your songs", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#app-content")).toBeFocused();
  expect(new URL(page.url()).hash).toBe("#/songs");
  await nav.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Fixture member", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-profile-layout]")).toBeVisible();
  // Real owner/profile and an explicitly empty current catalogue for this author.
  await expect(page.locator("[data-profile-activity]")).toBeVisible();
  await expect(
    page.getByText("No posts to show.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/followers|following/i)).toHaveCount(0);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeEnabled();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Fixture member", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-profile-layout]")).toBeVisible();
  await page.goto(origin + "/#/unknown");
  await expect(
    page.getByRole("heading", { name: "Post unavailable" }),
  ).toBeVisible();
});

test("reference PostCard owns the compact SongPlayer and post detail owns its activity links", async ({
  page,
}) => {
  const state = await serve(page, false, false, false, "strict-origin", {
    songs: true,
  });
  await page.goto(origin);
  const card = page.locator("[data-community-post]").first();
  await expect(card.getByText("Unknown author", { exact: true })).toBeVisible();
  await expect(card).not.toContainText("0x" + "4".repeat(64));
  const play = card.getByRole("button", {
    name: "Play Published fixture song",
    exact: true,
  });
  await expect(play).toBeVisible();
  await expect(card.locator("audio")).toHaveCount(1);
  await expect(card.locator("audio")).not.toHaveAttribute("src", /.+/);
  expect(
    await card.locator("audio").evaluate((audio: HTMLAudioElement) => ({
      paused: audio.paused,
      time: audio.currentTime,
      source: audio.currentSrc,
    })),
  ).toEqual({ paused: true, time: 0, source: "" });
  expect(state.audioRequests()).toBe(0);
  expect(
    state.events.filter(
      (event) =>
        event.path.startsWith("/api/") &&
        /grant|playback-access/.test(event.path),
    ),
  ).toHaveLength(0);
  await expect(card.locator("[data-song-player]")).toHaveAttribute(
    "data-song-player",
    "0x" + "3".repeat(64),
  );
  await play.click();
  const audio = card.getByLabel("Audio for Published fixture song", {
    exact: true,
  });
  await expect(audio).toHaveAttribute("src", origin + catalogAudioPath);
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await card
    .getByRole("link", { name: "Published fixture song", exact: true })
    .click();
  await page.reload();
  await expect(page.locator("[data-public-post-state=content]")).toBeVisible();
  expect(state.audioRequests()).toBeGreaterThan(0);
  const detailAudio = page
    .locator("[data-public-post-state=content]")
    .getByLabel("Audio for Published fixture song", { exact: true });
  await expect(detailAudio).not.toHaveAttribute("src", /.+/);
  expect(
    await detailAudio.evaluate((audio: HTMLAudioElement) => ({
      paused: audio.paused,
      time: audio.currentTime,
      source: audio.currentSrc,
    })),
  ).toEqual({ paused: true, time: 0, source: "" });
  await expect(
    page.locator("[data-public-post-state=content] [data-song-player]"),
  ).toHaveAttribute("data-song-player", "0x" + "3".repeat(64));
  await expect(
    page.getByText("A fixture lyric line", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Song activities" })
      .getByRole("link", { name: "Karaoke", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Study", exact: true }),
  ).toHaveCount(0);
});

test("the source SongPlayer retains playback failure and deliberate retry", async ({
  page,
}) => {
  const state = await serve(page, false, false, false, "strict-origin", {
    songs: true,
  });
  await page.route(origin + catalogAudioPath, (route) =>
    route.fulfill({ status: 503, body: "fixture unavailable" }),
  );
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Play Published fixture song", exact: true })
    .click();
  await expect(
    page.getByText("Audio could not be loaded. Retry playback.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.unroute(origin + catalogAudioPath);
  await page
    .getByRole("button", { name: "Retry playback", exact: true })
    .click();
  const audio = page.getByLabel("Audio for Published fixture song", {
    exact: true,
  });
  await expect
    .poll(() =>
      audio.evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
});

test("mobile community, library, post and composer use the accepted route chrome policies", async ({
  page,
}) => {
  await serve(page, true, false, true, "strict-origin", {
    songs: true,
    rewards: true,
  });
  for (const width of [320, 390, 767]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(origin);
    await expect(
      page.getByRole("button", { name: "Open navigation", exact: true }),
    ).toHaveCount(0);
    const footer = page.getByRole("navigation", {
      name: "Primary navigation",
      exact: true,
    });
    await expect(footer).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Main navigation", exact: true }),
    ).toBeHidden();
    await footer
      .getByRole("button", { name: "Your Songs", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Open navigation", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Your songs", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", {
        name: "Community navigation",
        exact: true,
      }),
    ).toBeVisible();
    // The source mobile drawer has community links; footer tabs own learner destinations.
    await expect(
      page
        .getByRole("navigation", { name: "Community navigation" })
        .getByRole("link", { name: "Your Songs", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Open navigation", exact: true }),
    ).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const bottom = await footer.boundingBox();
    expect(bottom!.y + bottom!.height).toBeLessThanOrEqual(844);
    await footer.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Fixture member", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-profile-layout]")).toBeVisible();
    await footer.getByRole("button", { name: "Home", exact: true }).click();
    await page
      .locator("[data-community-post]")
      .getByRole("link", { name: "Published fixture song", exact: true })
      .click();
    await expect(footer).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Open navigation", exact: true }),
    ).toHaveCount(0);
    const detail = page.locator("[data-public-post-state=content]");
    const author = detail.getByText("Unknown author", { exact: true });
    await expect(author).toBeInViewport();
    const authorBox = await author.boundingBox();
    expect(authorBox!.y).toBeGreaterThanOrEqual(64);
    const lyricsBox = await detail
      .getByText("A fixture lyric line", { exact: true })
      .boundingBox();
    const activitiesBox = await detail
      .getByRole("navigation", { name: "Song activities" })
      .boundingBox();
    expect(activitiesBox!.y).toBeLessThan(lyricsBox!.y);
    await page.reload();
    await expect(
      detail.getByText("Unknown author", { exact: true }),
    ).toBeInViewport();
    await page.goto(origin + "/#/publish");
    await expect(footer).toBeHidden();
    await expect(
      page.getByRole("main", { name: "Create a post", exact: true }),
    ).toBeVisible();
    await expect(page.locator('input[aria-label="Upload audio"]')).toHaveCount(
      1,
    );
    await expect(page.getByLabel("Song title", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Close composer", exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Next", exact: true }),
    ).toBeInViewport();
    await noHorizontalOverflow(page);
    await page.screenshot({
      path: test.info().outputPath("composer-mobile-" + width + ".png"),
      fullPage: true,
    });
  }
});

test("feed error is not an empty community and retains the source retry control", async ({
  page,
}) => {
  const state = await serve(page, true, false, false, "strict-origin", {
    feedOutage: true,
  });
  await page.goto(origin);
  await expect(
    page.getByText("No posts in this community yet.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  state.feedOutage(false);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByText("No posts in this community yet.", { exact: true }),
  ).toBeVisible();
});

test("Study opens from Your songs with bare chrome, and resumes the same lesson through back, forward and reload", async ({
  page,
}) => {
  const state = await serveStudy(page);
  const studyOrigin = new URL(state.url).origin;
  await page.goto(studyOrigin + "/#/songs");
  await page.getByRole("button", { name: "Study", exact: true }).click();
  await readyStudy(page);
  const lessonId = new URL(page.url()).searchParams.get("lesson");
  expect(lessonId).toBeTruthy();
  await expect(page.locator("[data-application-chrome]")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".live-study-overlay")).toHaveCount(0);
  await expect(page.locator("[data-application-chrome]")).toBeVisible();
  await page.goForward();
  await readyStudy(page);
  expect(new URL(page.url()).searchParams.get("lesson")).toBe(lessonId);
  await page.reload();
  await readyStudy(page);
  expect(new URL(page.url()).searchParams.get("lesson")).toBe(lessonId);
  expect(state.counts.starts).toBe(1);
  expect(state.counts.abandons).toBe(0);
  await page.getByRole("button", { name: "Exit study" }).click();
  expect(new URL(page.url()).searchParams.has("study")).toBe(false);
});

test("Karaoke retains its song route across reload and reads server attempt state without creating a take", async ({
  page,
}) => {
  await serve(page, true, false, false, "strict-origin", { songs: true });
  let attemptReads = 0,
    attemptWrites = 0;
  await page.route(origin + "/api/public/posts/*/karaoke", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        lines: [
          {
            lineId: "fixture-line",
            ordinal: 1,
            text: "A fixture lyric line",
            startMs: 0,
            endMs: 1000,
            words: [],
          },
        ],
        segments: [],
      }),
    }),
  );
  await page.route(origin + "/api/karaoke/attempt?*", (route) => {
    expect(route.request().method()).toBe("GET");
    if (route.request().method() !== "GET") attemptWrites++;
    attemptReads++;
    return route.fulfill({
      contentType: "application/json",
      body: '{"state":"none"}',
    });
  });
  await page.route(origin + "/api/karaoke/posts/*/instrumental", (route) =>
    route.fulfill({ status: 302, headers: { location: "/fixture-song.wav" } }),
  );
  await page.goto(origin + "/#/songs");
  await page.getByRole("button", { name: "Karaoke", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start karaoke", exact: true }),
  ).toBeVisible();
  const postId = new URL(page.url()).searchParams.get("sing");
  expect(postId).toBe("0x" + "3".repeat(64));
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Start karaoke", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("sing")).toBe(postId);
  expect(attemptReads).toBe(2);
  expect(attemptWrites).toBe(0);
  await page.goBack();
  await expect(page.locator(".live-karaoke-overlay")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Your songs", exact: true }),
  ).toBeVisible();
});

test("an anonymous Study deep link survives sign-in; malformed and missing song links recover visibly", async ({
  page,
}) => {
  const state = await serveStudy(page, { anonymous: true });
  await page.goto(state.url);
  const savedLink = new URL(page.url()).searchParams.get("study");
  await expect(
    page
      .locator(".live-study-overlay")
      .getByRole("heading", { name: "Sign in to study", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".live-study-overlay")
      .getByRole("button", { name: "Record", exact: true }),
  ).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("study")).toBe(savedLink);
  await page
    .locator(".live-study-overlay")
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await readyStudy(page);
  expect(new URL(page.url()).searchParams.get("study")).toBe(savedLink);
  expect(state.counts.starts).toBe(1);
  await page.goto(new URL(state.url).origin + "/?study=missing");
  await expect(
    page.getByText("This song is unavailable in this community.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.goto(new URL(state.url).origin + "/?study=a&sing=b");
  await expect(
    page.getByText("This practice link is invalid.", { exact: false }),
  ).toBeVisible();
  await page.goto(new URL(state.url).origin + "/#song-missing");
  await expect(
    page.getByText("This song is unavailable in this community.", {
      exact: false,
    }),
  ).toBeVisible();
});

test("intentional owner-profile refusal remains unavailable rather than an invented empty profile", async ({
  page,
}) => {
  await serve(page, true, false, false, "strict-origin", {
    profile: "unavailable",
  });
  await page.goto(origin + "/#/account");
  await expect(
    page.getByRole("heading", { name: "Profile unavailable", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "The profile could not be loaded.",
  );
  await expect(page.locator("[data-profile-layout]")).toHaveCount(0);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeEnabled();
});

test("anonymous mobile publish keeps actual community sign-in chrome and no private composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page);
  await page.goto(origin + "/#/publish");
  await expect(page.locator("[data-community-page]")).toBeVisible();
  await expect(
    page.getByText("No posts in this community yet.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }).first(),
  ).toBeInViewport();
  await expect(
    page.getByRole("navigation", { name: "Primary navigation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("main", { name: "Create a post", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('input[aria-label="Upload audio"]')).toHaveCount(0);
  await noHorizontalOverflow(page);
});

for (const policy of ["same-origin", "strict-origin"]) {
  test(`real pinned MOSS SDK parent-origin handshake with ${policy} referrer policy`, async ({
    page,
  }) => {
    // Controlled wallet peer, using the SDK's actual pinned Penpal transport.
    // It cancels connection; no fixture account or authenticated session exists.
    const moss = "https://account.megaeth.com";
    await serve(page, false, false, false, policy);
    await page.route(`${moss}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/penpal.mjs")
        return route.fulfill({
          contentType: "application/javascript",
          body: await readFile("node_modules/penpal/dist/penpal.mjs"),
        });
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><body><script type="module">
        import {connect,WindowMessenger} from '/penpal.mjs';
        document.body.dataset.referrer=document.referrer;
        const origin=document.referrer ? new URL(document.referrer).origin : null;
        if(origin) {
          const connection=connect({messenger:new WindowMessenger({remoteWindow:window.parent,allowedOrigins:[origin]}),methods:{status:()=>({status:'disconnected'}),connect:()=>({status:'cancelled'})}});
          const app=await connection.promise; await app.ready();
        }
      </script></body>`,
      });
    });
    await page.goto(origin + "/draft?draft=fixture-private-context");
    await page
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .locator("..")
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    const body = page.frameLocator("iframe").locator("body");
    await expect(body).toHaveAttribute(
      "data-referrer",
      policy === "same-origin" ? "" : origin + "/",
    );
    if (policy === "strict-origin")
      await expect(page.locator(".live-status")).toHaveText(
        "MOSS sign-in was cancelled.",
      );
    else await expect(page.locator(".live-status")).toHaveText("Opening MOSS…");
    await expect(
      page.getByRole("button", { name: "Connect creator wallet" }),
    ).toHaveCount(0);
  });
}
