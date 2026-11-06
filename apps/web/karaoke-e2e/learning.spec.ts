import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    console.log(
      JSON.stringify(
        await (await page.request.get("/__fixture/operator")).json(),
      ).slice(0, 14000),
    );
});

test("one enrollment sponsors repeated terminal publications, history export and revocation", async ({
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
    if (run === 1) {
      const consent = page.getByRole("dialog", {
        name: "Enable public learning results",
      });
      await expect(consent).toBeVisible();
      await consent
        .getByRole("button", { name: "Continue", exact: true })
        .click();
    }
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
  await page.getByRole("button", { name: "Learning settings" }).click();
  await page.getByRole("menuitem", { name: "Stop public enrollment" }).click();
  await expect(
    page.getByText(
      "Public enrollment stopped. Earlier publications remain public.",
    ),
  ).toBeVisible({ timeout: 20000 });
  expect((await records()).length).toBe(2);
});

test("missing server feedback stops playback and can reconnect the same open take", async ({
  page,
}) => {
  let suppressFeedback = true;
  await page.routeWebSocket(
    (url) => url.pathname.endsWith("/attempt"),
    (route) => {
      const server = route.connectToServer();
      server.onMessage((message) => {
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
  const consent = page.getByRole("dialog", {
    name: "Enable public learning results",
  });
  await consent.getByRole("button", { name: "Continue", exact: true }).click();
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
  await expect(page.locator(".karaoke-stage-rating")).toBeVisible({
    timeout: 5000,
  });
  expect((await state()).attempts).toHaveLength(before.attempts.length);
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 20000,
  });
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
  await page
    .getByRole("dialog", { name: "Enable public learning results" })
    .getByRole("button", { name: "Continue", exact: true })
    .click();
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
