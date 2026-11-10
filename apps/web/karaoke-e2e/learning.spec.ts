import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Sing", exact: true }).click();
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
    await expect(results.getByRole("button")).toHaveCount(0);
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
    if (run === 1) {
      await page.getByRole("button", { name: "Learning settings" }).click();
      const download = page.waitForEvent("download");
      await page
        .getByRole("menuitem", { name: "Download private history" })
        .click();
      const path = await (await download).path();
      const receipt = JSON.parse(await readFile(path!, "utf8"));
      expect(receipt).toBeTruthy();
      expect(JSON.stringify(receipt)).toContain("scribe_v2_realtime");
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Sign out" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Sing", exact: true }).click();
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
  await page.getByRole("button", { name: "Learning settings" }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Download private history",
  ]);
  await page.keyboard.press("Escape");
  expect((await records()).length).toBe(2);
});

test("persistent missing feedback stops after one automatic recovery and can retry the same open take", async ({
  page,
}) => {
  let suppressFeedback = true;
  let connections = 0;
  let latestDeliveredCertain = false;
  await page.clock.install();
  await page.routeWebSocket(
    (url) => url.pathname.endsWith("/attempt"),
    (route) => {
      connections++;
      const server = route.connectToServer();
      server.onMessage((message) => {
        if (!suppressFeedback && typeof message === "string") {
          const value = JSON.parse(message);
          const scores = value.lineScores ?? value.feedback?.lineScores;
          if (scores?.length) latestDeliveredCertain = !scores.at(-1).uncertain;
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
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Sing", exact: true }).click();
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
  await expect(page.getByRole("alert")).toHaveText(
    "Live scoring isn't responding. Playback stopped. Press Start karaoke to try again.",
    { timeout: 35000 },
  );
  expect(
    await page
      .locator(".live-karaoke audio")
      .evaluate((audio: HTMLAudioElement) => audio.paused),
  ).toBe(true);
  await expect(page.getByRole("region", { name: "Results" })).toHaveCount(0);
  const state = async () =>
    (await (await page.request.get("/__fixture/operator")).json()) as {
      attempts: { ticketId: string; ended: unknown | null }[];
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
  // A real capture gap can make the cached latest line uncertain. Wait for
  // the next measured line and its commit before requiring a visible rating.
  await expect
    .poll(() => latestDeliveredCertain, { timeout: 10000 })
    .toBe(true);
  await expect(page.locator(".karaoke-stage-rating")).toBeVisible({
    timeout: 1000,
  });
  expect((await state()).attempts).toHaveLength(before.attempts.length);
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
  const state = async () =>
    await (await page.request.get("/__fixture/operator")).json();
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
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Sing", exact: true }).click();
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
  expect(after.publications.length - before.publications.length).toBe(1);
  expect(tickets).toBe(1);
  expect(approvals).toBe(1);
});

test("a rejected ready cursor leaves a visible retry instead of a permanent startup spinner", async ({
  page,
}) => {
  await page.routeWebSocket(
    (url) => url.pathname.endsWith("/attempt"),
    (route) => {
      const server = route.connectToServer();
      server.onMessage((message) => {
        if (typeof message === "string") {
          const frame = JSON.parse(message);
          if (frame.type === "ready") {
            route.send(JSON.stringify({ ...frame, audioSequence: -1 }));
            return;
          }
        }
        route.send(message);
      });
    },
  );
  await page.goto("/?learner=6");
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Sing", exact: true }).click();
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText(
    "The scoring connection stopped. Press Start karaoke to try again.",
    { timeout: 20000 },
  );
  await expect(
    page.getByRole("button", { name: "Start karaoke" }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start singing" })).toHaveCount(
    0,
  );
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
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Sing", exact: true }).click();
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
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
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
