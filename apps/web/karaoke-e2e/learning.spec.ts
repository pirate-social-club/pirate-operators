import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const learnerScopes = new WeakMap<Page, { learner: number; wallet: string }>();
async function assertLearnerSession(page: Page) {
  const expected = learnerScopes.get(page);
  expect(expected).toBeTruthy();
  expect(new URL(page.url()).searchParams.get("learner")).toBe(
    String(expected!.learner),
  );
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/session");
        const value = await response.json();
        return {
          status: response.status(),
          authenticated: value.authenticated,
          wallet: value.mossAddress?.toLowerCase(),
        };
      },
      { timeout: 20000 },
    )
    .toEqual({
      status: 200,
      authenticated: true,
      wallet: expected!.wallet,
    });
}
async function connectLearner(page: Page, learner: number) {
  expect(new URL(page.url()).searchParams.get("learner")).toBe(String(learner));
  const connected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/__fixture/sign" &&
      response.request().postDataJSON()?.kind === "address",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const response = await connected;
  expect(response.request().postDataJSON()).toEqual({
    learner: String(learner),
    kind: "address",
  });
  const { address } = await response.json();
  expect(address).toMatch(/^0x[0-9a-f]{40}$/i);
  learnerScopes.set(page, { learner, wallet: address.toLowerCase() });
  await expect(
    page.getByText("Signed in. Choose a song to study or sing.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 20000 });
  await assertLearnerSession(page);
}
async function rawFragmentContext(page: Page) {
  const owner = await documentOwner(page);
  const search = await page.evaluate(() => {
    // Seed literal encoded bytes without URLSearchParams normalization. Keep
    // every other query value, hash and history state in the same document.
    const current = location.search;
    const next = /[?&]filter=/.test(current)
      ? current.replace(/([?&])filter=[^&]*/, "$1filter=a%20b")
      : current + (current ? "&" : "?") + "filter=a%20b";
    history.replaceState(
      history.state,
      "",
      location.pathname + next + location.hash,
    );
    return location.search;
  });
  expect(search).toMatch(/[?&]filter=a%20b(?:&|$)/);
  expect(search).not.toContain("filter=a+b");
  expect(await documentOwner(page)).toBe(owner);
  return search;
}
async function documentOwner(page: Page) {
  return page.evaluate(() => {
    const value = window as unknown as { __karaokeDocument?: string };
    return (value.__karaokeDocument ??= crypto.randomUUID());
  });
}
async function openPublishedKaraoke(page: Page) {
  await assertLearnerSession(page);
  const document = await documentOwner(page);
  const rawSearch = await rawFragmentContext(page);
  const manifest = await (await page.request.get("/__fixture/manifest")).json();
  const postId = manifest.song.postId;
  expect(postId).toMatch(/^0x[0-9a-f]{64}$/i);
  if (new URL(page.url()).hash !== `#song-${postId}`) {
    if (new URL(page.url()).hash && new URL(page.url()).hash !== "#/")
      await page.getByRole("link", { name: "Home", exact: true }).click();
    expect(new URL(page.url()).search).toBe(rawSearch);
    expect(await documentOwner(page)).toBe(document);
    const feed = await (await page.request.get("/api/feed")).json();
    const selected = feed.posts.find(
      (post: { manifest: { postId: string } }) =>
        post.manifest.postId === postId,
    );
    expect(selected).toBeTruthy();
    const link = page
      .getByRole("link", { name: selected.manifest.title, exact: true })
      .and(page.locator(`a[href="/#song-${postId}"]`));
    await expect(link).toHaveCount(1);
    expect(new URL(page.url()).search).toBe(rawSearch);
    await link.click();
    expect(new URL(page.url()).search).toBe(rawSearch);
    expect(await documentOwner(page)).toBe(document);
  }
  const karaoke = page
    .getByRole("link", { name: "Karaoke", exact: true })
    .and(page.locator(`a[href="/?sing=${postId}"]`));
  await expect(karaoke).toHaveCount(1);
  await karaoke.click();
  expect(new URL(page.url()).searchParams.get("sing")).toBe(postId);
  expect(await documentOwner(page)).toBe(document);
  await assertLearnerSession(page);
}
async function openLearningSettings(page: Page) {
  await assertLearnerSession(page);
  const document = await documentOwner(page);
  const rawSearch = await rawFragmentContext(page);
  expect(new URL(page.url()).search).toBe(rawSearch);
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  expect(new URL(page.url()).search).toBe(rawSearch);
  expect(await documentOwner(page)).toBe(document);
  expect(new URL(page.url()).search).toMatch(/[?&]filter=a%20b(?:&|$)/);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  expect(new URL(page.url()).search).toBe(rawSearch);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  expect(await documentOwner(page)).toBe(document);
  await assertLearnerSession(page);
}
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.log(
      "media-events",
      await page.evaluate(
        () =>
          (window as unknown as { __reloadMediaEvents?: unknown })
            .__reloadMediaEvents,
      ),
    );
    console.log(
      JSON.stringify(
        await (await page.request.get("/__fixture/operator")).json(),
      ).slice(0, 14000),
    );
  }
});

test("one enrollment sponsors repeated terminal publications and history export", async ({
  page,
}) => {
  let approvals = 0;
  let originalAttemptId: string | undefined;
  const historyTickets: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string") {
        const frame = JSON.parse(payload);
        if (frame.type === "ready") originalAttemptId = frame.attemptId;
      }
    }),
  );
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/karaoke/history")
      historyTickets.push(request.postDataJSON().ticketId);
  });
  page.on("dialog", () => {
    throw new Error("Native browser alerts are not part of the Karaoke design");
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/__fixture/sign")) {
      const input = request.postDataJSON();
      if (input.kind === "typed" && input.data?.primaryType === "Enrollment")
        approvals++;
    }
  });
  const capture = async (scene: string) => {
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await page.screenshot({
        path: test.info().outputPath(`${scene}-${size.width}.png`),
        animations: "disabled",
      });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  };
  let releaseSong!: () => void;
  const songWait = new Promise<void>((resolve) => {
    releaseSong = resolve;
  });
  await page.route("**/api/public/posts/*/karaoke", async (route) => {
    await songWait;
    await route.continue();
  });
  await page.goto("/?learner=8");
  await connectLearner(page, 8);
  await openPublishedKaraoke(page);
  await expect(
    page.getByRole("status", { name: "Loading karaoke" }),
  ).toBeVisible();
  await capture("loading");
  releaseSong();
  await expect(
    page.getByRole("button", { name: "Start karaoke" }),
  ).toBeVisible();
  await capture("ready");
  const records = async () =>
    (await (await page.request.get("/__fixture/records?learner=8")).json()) as {
      verified: boolean;
      problems: string[];
      lines: { status: string }[];
    }[];
  for (let run = 1; run <= 2; run++) {
    const activityDocument = await documentOwner(page);
    await page.getByRole("button", { name: "Start karaoke" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".karaoke-stage-rating")).toBeVisible({
      timeout: 25000,
    });
    if (run === 1) await capture("live-rating");
    await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
      timeout: 90000,
    });
    await expect(
      page.getByRole("button", { name: "Save your score" }),
    ).toHaveCount(0);
    const results = page.getByRole("region", { name: "Results" });
    await expect(results.locator("dt")).toHaveText([
      "Lyrics",
      "Timing",
      "Best combo",
    ]);
    await expect(
      results.getByRole("button", {
        name: /^(Save your score|Publish score|Save result)$/,
      }),
    ).toHaveCount(0);
    await expect(
      results.getByRole("button", { name: "Check again", exact: true }),
    ).toBeEnabled();
    await expect(
      results.getByRole("heading", { name: "Result publication", exact: true }),
    ).toBeVisible();
    if (run === 1) await capture("completion");
    await expect(
      page.getByRole("button", { name: "Sing again", exact: true }),
    ).toHaveCount(1);
    await expect(page.locator(".live-karaoke > .live-status")).toHaveCount(0);
    await expect
      .poll(async () => (await records()).length, { timeout: 15000 })
      .toBe(run);
    for (const result of await records()) {
      expect(result.verified, result.problems.join(", ")).toBe(true);
      expect(result.lines).toHaveLength(23);
      expect(result.lines.some((line) => line.status === "unpaid")).toBe(false);
    }
    expect(approvals).toBe(1);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    expect(await documentOwner(page)).toBe(activityDocument);
    if (run === 1) {
      await openLearningSettings(page);
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Download private history", exact: true })
        .click();
      const path = await (await download).path();
      const receipt = JSON.parse(await readFile(path!, "utf8"));
      expect(receipt).toBeTruthy();
      expect(JSON.stringify(receipt)).toContain("scribe_v2_realtime");
      expect(receipt.schema).toBe("pirate.learner-history/1");
      expect(receipt.activity).toBe("karaoke");
      expect(receipt.sessionId).toBe(originalAttemptId);
      const manifest = await (
        await page.request.get("/__fixture/manifest")
      ).json();
      expect(receipt.communityId).toBe(manifest.song.communityId);
      expect(receipt.source).toEqual(manifest.song);
      const operator = await (
        await page.request.get("/__fixture/operator")
      ).json();
      const original = operator.attempts.find(
        (attempt: { attemptId: string }) =>
          attempt.attemptId === originalAttemptId,
      );
      expect(original).toBeTruthy();
      expect(receipt.completedAt).toBe(original.ended.performanceEndedAt);
      expect(receipt.expiresAt).toBeGreaterThan(receipt.completedAt);
      expect(historyTickets).toEqual([original.ticketId]);
      expect((await download).suggestedFilename()).toBe(
        `learning-history-${original.ticketId}.json`,
      );
      await page.reload();
      await assertLearnerSession(page);
      await openPublishedKaraoke(page);
      await expect(
        page.getByRole("button", { name: "Start karaoke" }),
      ).toBeVisible();
      await expect(page.getByRole("region", { name: "Results" })).toHaveCount(
        0,
      );
      expect((await records()).length).toBe(1);
    }
  }
  // Results are always public: settings offer no way to stop publication.
  await openLearningSettings(page);
  await expect(
    page.getByRole("button", { name: "Download private history", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: /^(Stop publishing|Turn off public results|Save your score)$/,
    }),
  ).toHaveCount(0);
  expect((await records()).length).toBe(2);
});

test("persistent missing feedback stops after one automatic recovery and can retry the same open take", async ({
  page,
}) => {
  let suppressFeedback = true;
  let connections = 0;
  type ScoreEvidence = {
    lineId: string;
    scoredLineIndex: number;
    score: number;
    uncertain: boolean;
  };
  let manualRetry:
    | {
        connection: number;
        ticketId: string;
        attemptId: string;
        previousSequence: number;
        readyWatermark: number | null;
        latest: ScoreEvidence | null;
      }
    | undefined;
  await page.clock.install();
  await page.routeWebSocket(
    (url) => url.pathname.endsWith("/attempt"),
    (route) => {
      const connection = ++connections;
      let readyAttemptId: string | undefined;
      const server = route.connectToServer();
      server.onMessage((message) => {
        if (!suppressFeedback && typeof message === "string") {
          const value = JSON.parse(message);
          const retry = manualRetry;
          if (retry && connection === retry.connection) {
            if (value.type === "ready") {
              expect(new URL(route.url()).searchParams.get("ticketId")).toBe(
                retry.ticketId,
              );
              expect(value.attemptId).toBe(retry.attemptId);
              expect(value.resumed).toBe(true);
              expect(value.audioSequence).toBeGreaterThanOrEqual(
                retry.previousSequence,
              );
              readyAttemptId = value.attemptId;
              const cached = (value.feedback?.lineScores ??
                []) as ScoreEvidence[];
              expect(Array.isArray(cached)).toBe(true);
              expect(
                cached.every(
                  (line) =>
                    Number.isInteger(line.scoredLineIndex) &&
                    line.scoredLineIndex >= 0,
                ),
              ).toBe(true);
              if (cached.length)
                expect(
                  cached.some(
                    (line) => line.lineId === value.feedback.latestLineId,
                  ),
                ).toBe(true);
              // READY is restored evidence, never a fresh/renderable score.
              retry.readyWatermark = Math.max(
                -1,
                ...cached.map((line) => line.scoredLineIndex),
              );
              retry.latest = null;
            } else if (
              value.type === "line_scores" &&
              readyAttemptId === retry.attemptId &&
              retry.readyWatermark !== null
            ) {
              const latest = (value.lineScores as ScoreEvidence[]).find(
                (line) => line.lineId === value.latestLineId,
              );
              // This message type can replay READY's cached identity as well.
              retry.latest =
                latest &&
                /^0x[0-9a-f]{64}$/i.test(latest.lineId) &&
                Number.isInteger(latest.scoredLineIndex) &&
                latest.scoredLineIndex > retry.readyWatermark &&
                latest.uncertain === false &&
                Number.isFinite(latest.score) &&
                latest.score >= 0 &&
                latest.score <= 1
                  ? latest
                  : null;
            }
          }
        }
        if (suppressFeedback && typeof message === "string") {
          const value = JSON.parse(message);
          if (value.type === "ready") {
            route.send(JSON.stringify({ ...value, feedback: null }));
            return;
          }
        }
        if (
          suppressFeedback &&
          typeof message === "string" &&
          JSON.parse(message).type === "line_scores"
        )
          return;
        route.send(message);
      });
    },
  );
  await page.goto("/?learner=7");
  await connectLearner(page, 7);
  await openPublishedKaraoke(page);
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator(".live-karaoke audio")
        .evaluate((audio: HTMLAudioElement) => audio.currentTime),
    )
    .toBeGreaterThan(3);
  await page.clock.fastForward(11000);
  await expect.poll(() => connections).toBe(2);
  // The second ready arrives, but this fixture withholds all score evidence.
  await expect
    .poll(async () => {
      const state = await (
        await page.request.get("/__fixture/operator")
      ).json();
      return state.attempts.find((a: { finalized: boolean }) => !a.finalized)
        ?.generation;
    })
    .toBe(2);
  await page.waitForTimeout(500);
  await page.clock.fastForward(11000);
  await expect(page.getByRole("alert").locator("p")).toHaveText(
    "Live scoring isn't responding. Playback stopped. Press Start karaoke to try again.",
    { timeout: 35000 },
  );
  await expect(
    page.getByRole("alert").getByRole("button", {
      name: "Check status",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page
      .locator(".live-karaoke audio")
      .evaluate((audio: HTMLAudioElement) => audio.paused),
  ).toBe(true);
  await expect(page.getByRole("region", { name: "Results" })).toHaveCount(0);
  const state = async () =>
    (await (await page.request.get("/__fixture/operator")).json()) as {
      attempts: {
        ticketId: string;
        attemptId: string;
        generation: number;
        ended: unknown | null;
      }[];
      audio: { ticketId: string; lastSequence: number }[];
    };
  const before = await state();
  const open = before.attempts.filter((attempt) => attempt.ended === null);
  expect(open).toHaveLength(1);
  expect(connections).toBe(2);
  const ticketId = open[0].ticketId;
  const previousSequence = before.audio.find(
    (row) => row.ticketId === ticketId,
  )!.lastSequence;
  manualRetry = {
    connection: connections + 1,
    ticketId,
    attemptId: open[0].attemptId,
    previousSequence,
    readyWatermark: null,
    latest: null,
  };
  suppressFeedback = false;
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect
    .poll(
      async () =>
        (await state()).audio.find((row) => row.ticketId === ticketId)!
          .lastSequence,
      { timeout: 5000 },
    )
    .toBeGreaterThan(previousSequence);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Correlate fresh protocol identity and actual visible DOM in one existing
  // ten-second window; cached READY/replayed line_scores cannot start a timer.
  await expect
    .poll(
      async () => {
        const latest = manualRetry?.latest;
        if (!latest) return false;
        const key = `${latest.lineId}:${latest.scoredLineIndex}:${latest.score}`;
        const rating = page.locator(
          `.karaoke-stage-rating[data-rating-key="${key}"]`,
        );
        if (!(await rating.isVisible())) return false;
        const points = await rating
          .locator(".karaoke-stage-rating-points")
          .allTextContents();
        return (
          points.length === 1 &&
          points[0] === `+${Math.round(latest.score * 100)}`
        );
      },
      { timeout: 10000 },
    )
    .toBe(true);
  expect(connections).toBe(manualRetry.connection);
  const resumed = await state();
  expect(resumed.attempts).toHaveLength(before.attempts.length);
  expect(
    resumed.attempts.find((attempt) => attempt.ticketId === ticketId),
  ).toMatchObject({
    ticketId,
    attemptId: manualRetry.attemptId,
    generation: open[0].generation + 1,
  });
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 40000,
  });
});

test("missing feedback recovers automatically on the same ticket and provider stream", async ({
  page,
}) => {
  let connections = 0,
    tickets = 0,
    approvals = 0;
  let originalAttemptId: string | undefined;
  const state = async () => {
    const response = await page.request.get("/__fixture/operator");
    expect(response.ok()).toBe(true);
    return await response.json();
  };
  const before = await state();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/karaoke/tickets") tickets++;
    if (request.url().endsWith("/__fixture/sign")) {
      const input = request.postDataJSON();
      if (input.kind === "typed" && input.data?.primaryType === "Enrollment")
        approvals++;
    }
  });
  await page.routeWebSocket(
    (url) => url.pathname.endsWith("/attempt"),
    (route) => {
      const initial = ++connections === 1;
      const server = route.connectToServer();
      server.onMessage((message) => {
        if (typeof message === "string") {
          const value = JSON.parse(message);
          if (value.type === "ready") {
            expect(value.attemptId).toMatch(/^0x[0-9a-f]{64}$/i);
            if (initial) originalAttemptId ??= value.attemptId;
            expect(value.attemptId).toBe(originalAttemptId);
            if (!initial) expect(value.resumed).toBe(true);
          }
        }
        if (
          initial &&
          typeof message === "string" &&
          JSON.parse(message).type === "line_scores"
        )
          return;
        route.send(message);
      });
    },
  );
  await page.goto("/?learner=5");
  await connectLearner(page, 5);
  await openPublishedKaraoke(page);
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => connections, { timeout: 20000 }).toBe(2);
  await expect(page.locator(".karaoke-stage-rating")).toBeVisible({
    timeout: 5000,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 30000,
  });
  const after = await state();
  const previousTickets = new Set(
    before.attempts.map((a: { ticketId: string }) => a.ticketId),
  );
  const added = after.attempts.filter(
    (a: { ticketId: string }) => !previousTickets.has(a.ticketId),
  );
  expect(added).toHaveLength(1);
  expect(added[0].generation).toBe(2);
  expect(after.simulator.minted - before.simulator.minted).toBe(1);
  expect(added[0].attemptId).toBe(originalAttemptId);
  // Results can precede a mined publication. Read fresh ticket state and all
  // raw events together until this separate milestone, without deduplication.
  await expect
    .poll(
      async () => {
        const current = await state();
        const response = await page.request.get(
          "/__fixture/result-events?learner=5",
        );
        expect(response.ok()).toBe(true);
        const events = (await response.json()) as {
          sessionId: string;
          revision: number;
          verified: boolean;
        }[];
        return {
          publications: current.publications.filter(
            (row: { key: string }) =>
              row.key === `publicationV2:${added[0].ticketId}`,
          ).length,
          events: events
            .filter((event) => event.sessionId === originalAttemptId)
            .map(({ sessionId, revision, verified }) => ({
              sessionId,
              revision,
              verified,
            })),
        };
      },
      { timeout: 10000 },
    )
    .toEqual({
      publications: 1,
      events: [{ sessionId: originalAttemptId, revision: 1, verified: true }],
    });
  expect(tickets).toBe(1);
  expect(approvals).toBe(1);
});

test("a rejected ready cursor leaves a visible retry instead of a permanent startup spinner", async ({
  page,
}) => {
  let rejectedReady = 0,
    ticketPosts = 0,
    ticketsAtReady: number | undefined;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/karaoke/tickets")
      ticketPosts++;
  });
  await page.routeWebSocket(
    (url) => url.pathname.endsWith("/attempt"),
    (route) => {
      const server = route.connectToServer();
      server.onMessage((message) => {
        if (typeof message === "string") {
          const frame = JSON.parse(message);
          if (frame.type === "ready") {
            rejectedReady++;
            ticketsAtReady ??= ticketPosts;
            route.send(JSON.stringify({ ...frame, audioSequence: -1 }));
            return;
          }
        }
        route.send(message);
      });
    },
  );
  await page.goto("/?learner=6");
  await connectLearner(page, 6);
  await openPublishedKaraoke(page);
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert").locator("p")).toHaveText(
    "Scoring could not connect. Try starting your take again.",
    { timeout: 20000 },
  );
  await expect(
    page.getByRole("alert").getByRole("button", {
      name: "Check status",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start karaoke" }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start singing" })).toHaveCount(
    0,
  );
  expect(rejectedReady).toBe(1);
  expect(ticketsAtReady).toBeGreaterThan(0);
  expect(ticketPosts).toBe(ticketsAtReady);
  expect(
    await page
      .locator(".live-karaoke audio")
      .evaluate((audio: HTMLAudioElement) => audio.paused),
  ).toBe(true);
});

test("reload with delayed audio metadata preserves position and shows fresh later-line grades", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const events: unknown[] = [];
    Object.assign(window, { __reloadMediaEvents: events });
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "currentTime",
    )!;
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      ...descriptor,
      set(value: number) {
        events.push({ type: "seek", value, readyState: this.readyState });
        descriptor.set!.call(this, value);
      },
    });
    for (const type of ["loadedmetadata", "seeked", "playing", "emptied"])
      document.addEventListener(
        type,
        (event) => {
          const audio = event.target as HTMLMediaElement;
          events.push({
            type,
            currentTime: audio.currentTime,
            readyState: audio.readyState,
          });
        },
        true,
      );
  });
  let feedbackCount = 0;
  let postReload = false;
  let restored = false;
  let freshLaterLine = false;
  let baseline = 0;
  let ticketRequests = 0;
  let activeAttemptId: string | undefined;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/karaoke/tickets")) ticketRequests++;
  });
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload);
      if (frame.type === "ready") {
        if (postReload) restored = frame.resumed === true;
        else activeAttemptId = frame.attemptId;
      }
      if (frame.type === "line_scores") {
        feedbackCount = frame.lineScores.length;
        if (
          postReload &&
          feedbackCount > baseline &&
          !frame.lineScores.at(-1).uncertain
        )
          freshLaterLine = true;
      }
    }),
  );
  await page.goto("/?learner=8");
  await connectLearner(page, 8);
  await openPublishedKaraoke(page);
  await page
    .getByRole("button", { name: "Start karaoke", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => feedbackCount, { timeout: 30000 }).toBeGreaterThan(2);
  const priorPosition = await page
    .locator(".live-karaoke audio")
    .evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000);
  baseline = feedbackCount;
  const before = await (await page.request.get("/__fixture/operator")).json();
  const attempt = before.attempts.find(
    (a: { attemptId: string }) => a.attemptId === activeAttemptId,
  );
  expect(attempt).toBeTruthy();
  postReload = true;
  let releaseAudio!: () => void;
  const waitAudio = new Promise<void>((resolve) => {
    releaseAudio = resolve;
  });
  await page.route("**/api/karaoke/posts/*/instrumental", async (route) => {
    await waitAudio;
    await route.continue();
  });
  try {
    // Install the metadata delay before reload: the shell restores this route
    // immediately, so reopening the covered background song is not a user action.
    await page.reload({ waitUntil: "domcontentloaded" });
    await assertLearnerSession(page);
    await expect(page).toHaveURL(/[?&]sing=/);
    await page
      .getByRole("button", { name: "Start karaoke", exact: true })
      .click();
    await expect.poll(() => restored, { timeout: 10000 }).toBe(true);
    expect(
      await page
        .locator(".live-karaoke audio")
        .evaluate((audio: HTMLAudioElement) => audio.readyState),
    ).toBe(0);
    // Retained grades are history, not a newly earned transient rating.
    await expect(page.locator(".karaoke-stage-rating")).toHaveCount(0);
    await page.waitForTimeout(2500);
  } finally {
    releaseAudio();
  }
  await expect
    .poll(
      () =>
        page
          .locator(".live-karaoke audio")
          .evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000),
      { timeout: 5000 },
    )
    .toBeGreaterThan(priorPosition + 2000);
  await expect.poll(() => freshLaterLine, { timeout: 25000 }).toBe(true);
  await expect(page.locator(".karaoke-stage-rating")).toBeVisible();
  const after = await (await page.request.get("/__fixture/operator")).json();
  expect(
    after.attempts.find(
      (a: { ticketId: string }) => a.ticketId === attempt.ticketId,
    ).generation,
  ).toBe(2);
  expect(after.simulator.minted).toBe(before.simulator.minted);
  expect(ticketRequests).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
