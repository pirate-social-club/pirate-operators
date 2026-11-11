// Explicit browser fixture. HTTP cryptography/D1 and live acceptance are
// qualified separately; these tests exercise the built client and reload flow.
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { serveStudy } from "./study-fixture.ts";

const origin = "https://community.example";
async function serve(
  page: Page,
  authenticated = false,
  directoryOutage = false,
  releasing = false,
  referrerPolicy = "strict-origin",
  options: { songs?: boolean; rewards?: boolean; feedOutage?: boolean } = {},
) {
  let creatorCalls = 0,
    reservations = 0,
    storedUploads = 0,
    uploadCalls = 0,
    phase = "admission";
  let submissionId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    postId = "0x" + "4".repeat(64),
    jobId = `publication:${submissionId}`;
  let reserved = false,
    sealed = false;
  const keys = new Set<string>(),
    stored = new Set<string>();
  const stemRows = new Map<
    string,
    { slot: string; state: string; sha256: string; byteLength: number }
  >();
  type Upload = {
    submissionId: string;
    postId: string;
    title: string;
    state: string;
    jobId: string | null;
  };
  const history: Upload[] = [];
  let songTitle = "Browser saved song";
  const currentUpload = (): Upload => ({
    submissionId,
    postId,
    title: songTitle,
    state: sealed ? phase : "uploaded",
    jobId: sealed ? jobId : null,
  });
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/.well-known/pirate-client.json" && directoryOutage)
      return json({ error: "fixture_directory_unavailable" }, 503);
    if (path === "/.well-known/pirate-client.json")
      return json({
        schema: "pirate.community-client-config/1",
        communityId: "fixture",
        canonicalOrigin: origin,
        apiBase: "/api",
      });
    if (path === "/api/public/community")
      return json({ name: "Browser Fixture Community" });
    if (path === "/api/capabilities")
      return json({
        signIn: true,
        creatorConnection: false,
        upload: releasing,
        publication: releasing,
        policyVersion: "pirate-owner-curated/2026-11-08/1",
        rewards: options.rewards,
      });
    if (path === "/api/feed" && options.feedOutage)
      return json({ error: "fixture_feed_unavailable" }, 503);
    if (path === "/api/rewards/offers") return json({ offers: [] });
    if (path === "/api/feed")
      return json({
        schema: "pirate.community-feed/1",
        communityId: "fixture",
        posts: options.songs
          ? [
              {
                manifest: {
                  schema: "pirate.community-post/3",
                  postId: "0x" + "3".repeat(64),
                  authorId: "0x" + "4".repeat(64),
                  title: "Published fixture song",
                  language: "en",
                  rating: "general",
                },
                audioUrl: "/fixture-song.wav",
                postUrl: "/posts/fixture",
                transactionHash: "0x" + "5".repeat(64),
                lyricsText: "A fixture lyric line",
              },
            ]
          : [],
      });
    if (path === "/fixture-song.wav") {
      // A decodable local audio fixture; no live song/provider acceptance claim.
      const samples = 16000,
        wav = Buffer.alloc(44 + samples * 2);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24);
      wav.writeUInt32LE(32000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(samples * 2, 40);
      for (let i = 0; i < samples; i++)
        wav.writeInt16LE(
          Math.round(Math.sin((i * 440 * Math.PI * 2) / 16000) * 1000),
          44 + i * 2,
        );
      return route.fulfill({ contentType: "audio/wav", body: wav });
    }
    if (path === "/api/uploads" && request.method() === "GET")
      return json({ uploads: reserved ? [currentUpload(), ...history] : [] });
    if (releasing && path === "/api/uploads" && request.method() === "POST") {
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON().original).toBe(true);
      const key = request.headers()["idempotency-key"]!;
      if (!keys.has(key)) {
        if (reserved) history.push(currentUpload());
        keys.add(key);
        reservations++;
        if (reservations > 1) {
          submissionId = `bbbbbbbb-bbbb-4bbb-bbbb-${String(reservations).padStart(12, "0")}`;
          postId = "0x" + String(reservations + 4).repeat(64);
          jobId = `publication:${submissionId}`;
        }
        reserved = true;
        sealed = false;
        phase = "admission";
        songTitle = request.postDataJSON().title;
      }
      return json({ submissionId, postId, state: "reserved" }, 201);
    }
    if (releasing && path === `/api/uploads/${submissionId}/audio`) {
      uploadCalls++;
      expect(request.method()).toBe("PUT");
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      if (!stored.has(submissionId)) {
        stored.add(submissionId);
        storedUploads++;
        if (storedUploads === 1) return route.abort("connectionreset");
      }
      return json({ uploaded: true });
    }
    const stem =
      /^\/api\/uploads\/([^/]+)\/stems(?:\/(instrumental|vocals))?$/.exec(path);
    if (releasing && stem) {
      if (!stem[2])
        return json({
          stems: [...stemRows]
            .filter(([key]) => key.startsWith(stem[1]! + "/"))
            .map(([, row]) => row),
        });
      const key = stem[1] + "/" + stem[2];
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      if (request.method() === "POST") {
        const input = request.postDataJSON(),
          existing = stemRows.get(key);
        if (existing) expect(existing.sha256).toBe(input.sha256);
        else stemRows.set(key, { slot: stem[2], state: "reserved", ...input });
        return json({ stem: stemRows.get(key) }, 201);
      }
      expect(request.method()).toBe("PUT");
      const row = stemRows.get(key)!;
      expect(row).toBeTruthy();
      expect(request.postDataBuffer()!.length).toBe(row.byteLength);
      row.state = "sealed";
      return json({ sealed: true });
    }
    if (releasing && path === `/api/uploads/${submissionId}/seal`) {
      expect(
        ["instrumental", "vocals"].every(
          (slot) => stemRows.get(submissionId + "/" + slot)?.state === "sealed",
        ),
      ).toBe(true);
      sealed = true;
      return json({ jobId, postId }, 202);
    }
    if (
      releasing &&
      path.startsWith("/api/jobs/") &&
      request.method() === "GET"
    ) {
      const id = decodeURIComponent(path.slice("/api/jobs/".length)),
        row = [currentUpload(), ...history].find((row) => row.jobId === id)!;
      expect(row).toBeTruthy();
      return json({
        schema: "pirate.publication-job-view/1",
        jobId: row.jobId,
        submissionId: row.submissionId,
        postId: row.postId,
        phase: row.state,
        errorCode: null,
        resumable: row.state === "uncertain",
      });
    }
    if (releasing && path === `/api/jobs/${encodeURIComponent(jobId)}/resume`) {
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      phase = "publication";
      return json({ resuming: true });
    }
    if (path === "/api/session")
      return authenticated
        ? json({
            authenticated: true,
            authorId: "0x" + "1".repeat(64),
            mossAddress: "0x" + "2".repeat(40),
            csrf: "fixture-csrf",
            creator: null,
            pendingConnection: null,
            // Only the authorized owner sees release controls.
            publisher: releasing,
          })
        : json({ error: "session_required" }, 401);
    if (path.startsWith("/api/creator/")) {
      creatorCalls++;
      return json({ error: "fixture_creator_unused" }, 410);
    }
    if (path === "/api/logout") {
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      authenticated = false;
      return json({ signedOut: true });
    }
    if (path.startsWith("/api/"))
      throw new Error(`Unexpected fixture call: ${path}`);
    const filename = path.startsWith("/app/assets/")
        ? path.slice(1)
        : "index.html",
      file = resolve("dist/live", filename);
    expect(file.startsWith(resolve("dist/live") + "/")).toBe(true);
    const contentType = filename.endsWith(".js")
      ? "application/javascript"
      : filename.endsWith(".css")
        ? "text/css"
        : "text/html";
    await route.fulfill({
      contentType,
      body: await readFile(file),
      headers: { "referrer-policy": referrerPolicy },
    });
  });
  return {
    creatorCalls: () => creatorCalls,
    reservations: () => reservations,
    storedUploads: () => storedUploads,
    uploadCalls: () => uploadCalls,
    phase: (value: string) => {
      phase = value;
    },
  };
}

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
  await page.goto(origin + "/#/settings");
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
  // The authorized owner publishes with no creator connection step.
  await expect(page.getByText(/creator wallet/i)).toHaveCount(0);
  await expect(page.getByText(/royalt/i)).toHaveCount(0);
  await page
    .getByLabel("Song title", { exact: true })
    .fill("Browser saved song");
  await page.getByLabel("Lyrics", { exact: true }).fill("A saved lyric line");
  await page.getByLabel("Recording", { exact: true }).setInputFiles({
    name: "saved-song.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("ID3browser-local-upload-fixture"),
  });
  await page.getByRole("checkbox").check();
  for (const slot of ["Instrumental", "Vocals"])
    await page.getByLabel(slot, { exact: true }).setInputFiles({
      name: slot + ".mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("ID3" + slot + "-browser-fixture"),
    });
  await page.getByRole("button", { name: "Submit song", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue saved release" }),
  ).toBeEnabled();
  expect(state.reservations()).toBe(1);
  expect(state.storedUploads()).toBe(1);
  await page.reload();
  await expect(page.getByText("Saved recording: saved-song.mp3")).toBeVisible();
  await expect(page.getByLabel("Song title", { exact: true })).toHaveValue(
    "Browser saved song",
  );
  await page.getByRole("button", { name: "Continue saved release" }).click();
  await expect(
    page.getByText(
      "Submitted. Your progress is saved; processing continues after you leave.",
    ),
  ).toBeVisible();
  expect(state.reservations()).toBe(1);
  expect(state.storedUploads()).toBe(1);
  expect(state.uploadCalls()).toBe(2);
  state.phase("uncertain");
  await page.reload();
  await page.getByRole("button", { name: "Check and resume" }).click();
  await expect(page.getByText("Publishing to the community.")).toBeVisible();
  state.phase("held");
  await page.reload();
  await expect(
    page.getByText(
      "This release is held for review and has not been published.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check and resume" }),
  ).toHaveCount(0);
  state.phase("failed");
  await page.reload();
  await expect(
    page.getByText("This release was rejected and has not been published."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check and resume" }),
  ).toHaveCount(0);
  expect(state.reservations()).toBe(1);
  await page.getByRole("button", { name: "Start another release" }).click();
  await page
    .getByLabel("Song title", { exact: true })
    .fill("Corrected browser song");
  await page.getByLabel("Recording", { exact: true }).setInputFiles({
    name: "corrected.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("ID3corrected-local-fixture"),
  });
  await page.getByRole("checkbox").check();
  for (const slot of ["Instrumental", "Vocals"])
    await page
      .getByLabel(slot, { exact: true })
      .first()
      .setInputFiles({
        name: slot + "-corrected.mp3",
        mimeType: "audio/mpeg",
        buffer: Buffer.from("ID3corrected-" + slot + "-browser-fixture"),
      });
  await page.getByRole("button", { name: "Submit song", exact: true }).click();
  await expect(
    page.getByText(
      "Submitted. Your progress is saved; processing continues after you leave.",
    ),
  ).toBeVisible();
  expect(state.reservations()).toBe(2);
  expect(state.storedUploads()).toBe(2);
  await expect(
    page.getByText("This release was rejected and has not been published."),
  ).toBeVisible();
  state.phase("published");
  await page.reload();
  await expect(
    page.getByText("Published. Find your song in Latest songs."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start another release" }).click();
  await expect(page.getByLabel("Song title", { exact: true })).toBeEditable();
  await expect(page.getByText(/regist/i)).toHaveCount(0);
  expect(state.creatorCalls()).toBe(0);
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
  await expect(page.locator("header[data-appearance]")).toHaveCount(0);
  await expect(
    nav.getByRole("link", { name: "Create", exact: true }),
  ).toHaveCount(0);
  await expect(
    nav.getByRole("link", { name: "Release a song", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator("[data-community-post-slot]")
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
    page.getByRole("heading", { name: "Profile", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-profile-layout]")).toHaveCount(0);
  // No profile read exists in this HTTP fixture: no invented posts/counters.
  await expect(page.locator("[data-profile-activity]")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeEnabled();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Profile", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-profile-layout]")).toHaveCount(0);
  await page.goto(origin + "/#/unknown");
  await expect(
    page.getByRole("heading", { name: "Post unavailable" }),
  ).toBeVisible();
});

test("reference PostCard owns the compact SongPlayer and post detail owns its activity links", async ({
  page,
}) => {
  await serve(page, false, false, false, "strict-origin", { songs: true });
  await page.goto(origin);
  const card = page.locator("[data-community-post]").first();
  await expect(card.getByText("Unknown author", { exact: true })).toBeVisible();
  await expect(card).not.toContainText("0x" + "4".repeat(64));
  const play = card.getByRole("button", {
    name: "Play Published fixture song",
    exact: true,
  });
  await expect(play).toBeVisible();
  await expect(card.locator("audio")).toHaveCount(0);
  await play.click();
  const audio = card.getByLabel("Audio for Published fixture song", {
    exact: true,
  });
  await expect(audio).toHaveAttribute("src", origin + "/fixture-song.wav");
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
  await serve(page, false, false, false, "strict-origin", { songs: true });
  await page.route(origin + "/fixture-song.wav", (route) =>
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
  await page.unroute(origin + "/fixture-song.wav");
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
    await expect(page.locator("header[data-appearance]")).toHaveCount(0);
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
    await expect(page.locator("header[data-appearance]")).toBeVisible();
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
      page.getByRole("heading", { name: "Profile", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-profile-layout]")).toHaveCount(0);
    await footer.getByRole("button", { name: "Home", exact: true }).click();
    await page
      .locator("[data-community-post]")
      .getByRole("link", { name: "Published fixture song", exact: true })
      .click();
    await expect(footer).toBeHidden();
    await expect(page.locator("header[data-appearance]")).toHaveCount(0);
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
    await expect(page.getByLabel("Song title", { exact: true })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("composer-mobile-" + width + ".png"),
      fullPage: true,
    });
  }
});

test("feed error is not an empty community and retains the source retry control", async ({
  page,
}) => {
  await serve(page, true, false, false, "strict-origin", { feedOutage: true });
  await page.goto(origin);
  await expect(
    page.getByText("No posts in this community yet.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  await page.route(origin + "/api/feed", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"posts":[]}' }),
  );
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
  await expect(page.locator(".study-surface h2")).toBeVisible();
  const lessonId = new URL(page.url()).searchParams.get("lesson");
  expect(lessonId).toBeTruthy();
  await expect(page.locator("[data-application-chrome]")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".live-study-overlay")).toHaveCount(0);
  await expect(page.locator("[data-application-chrome]")).toBeVisible();
  await page.goForward();
  await expect(page.locator(".study-surface h2")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("lesson")).toBe(lessonId);
  await page.reload();
  await expect(page.locator(".study-surface h2")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("lesson")).toBe(lessonId);
  expect(state.counts.starts).toBe(1);
  await page.getByRole("button", { name: "Exit study" }).click();
  expect(new URL(page.url()).searchParams.has("study")).toBe(false);
});

test("Karaoke retains its song route across reload and reads server attempt state without creating a take", async ({
  page,
}) => {
  await serve(page, true, false, false, "strict-origin", { songs: true });
  let attemptReads = 0;
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
  await expect(
    page.getByText(
      "Sign in with MOSS to open this song. Your practice link is saved.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.locator(".live-study-overlay")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .locator("..")
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.locator(".study-surface h2")).toBeVisible();
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
