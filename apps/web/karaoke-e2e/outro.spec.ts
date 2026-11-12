import { expect, test, type Page } from "@playwright/test";

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

test("scoring releases the microphone while the outro plays to its natural end", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    const contexts: AudioContext[] = [];
    Object.assign(window, {
      __outroStreams: streams,
      __outroContexts: contexts,
    });
    window.AudioContext = new Proxy(window.AudioContext, {
      construct(target, args) {
        const context = Reflect.construct(target, args);
        contexts.push(context);
        return context;
      },
    });
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      streams.push(stream);
      return stream;
    };
  });
  let closed = false;
  let connections = 0;
  let tickets = 0;
  let attemptId: string;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/karaoke/tickets")) tickets++;
  });
  page.on("websocket", (socket) => {
    connections++;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload);
      if (frame.type === "ready") attemptId = frame.attemptId;
      if (frame.code === "attempt_closed") closed = true;
    });
  });
  await page.goto("/?learner=9");
  await connectLearner(page, 9);
  await openPublishedKaraoke(page);
  await page
    .getByRole("button", { name: "Start karaoke", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => closed, { timeout: 40000 }).toBe(true);
  const audio = page.locator(".live-karaoke audio");
  const during = await audio.evaluate((element: HTMLAudioElement) => ({
    currentTime: element.currentTime,
    duration: element.duration,
    paused: element.paused,
    ended: element.ended,
  }));
  expect(during.duration - during.currentTime).toBeGreaterThan(4);
  expect(during.paused).toBe(false);
  expect(during.ended).toBe(false);
  await expect(page.getByRole("region", { name: "Results" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const streams = (window as unknown as { __outroStreams: MediaStream[] })
          .__outroStreams;
        return (
          streams.length > 0 &&
          streams.every((stream) =>
            stream.getTracks().every((track) => track.readyState === "ended"),
          )
        );
      }),
    )
    .toBe(true);
  const before = await (await page.request.get("/__fixture/operator")).json();
  const attempt = before.attempts.find(
    (value: { attemptId: string }) => value.attemptId === attemptId,
  );
  expect(attempt.ended.status).toBe("completed");
  expect(
    (attempt.ended.performanceEndedAt - attempt.startedAt) * 1000,
  ).toBeLessThan(during.duration * 1000 - 4000);
  const sequence = before.audio.find(
    (value: { ticketId: string }) => value.ticketId === attempt.ticketId,
  ).lastSequence;
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 25000,
  });
  expect(
    await audio.evaluate((element: HTMLAudioElement) => element.ended),
  ).toBe(true);
  const after = await (await page.request.get("/__fixture/operator")).json();
  expect(
    after.audio.find(
      (value: { ticketId: string }) => value.ticketId === attempt.ticketId,
    ).lastSequence,
  ).toBe(sequence);
  expect(after.simulator.minted).toBe(before.simulator.minted);
  expect(connections).toBe(1);
  expect(tickets).toBe(1);
  const publicRecords = async () =>
    (await page.request.get("/__fixture/records?learner=9")).json();
  await expect
    .poll(async () => (await publicRecords()).length, { timeout: 15000 })
    .toBe(1);
  const records = await publicRecords();
  expect(records).toHaveLength(1);
  expect(records[0].verified, records[0].problems.join(", ")).toBe(true);
  expect(records[0].lines).toHaveLength(23);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The same enrollment permits another take. A suspended playback context
  // after capture has ended must expose the result, without reopening capture.
  closed = false;
  await page.getByRole("button", { name: "Sing again", exact: true }).click();
  await expect
    .poll(
      () =>
        audio.evaluate(
          (element: HTMLAudioElement) =>
            !element.paused &&
            element.currentTime > 0 &&
            element.currentTime < 3,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect.poll(() => closed, { timeout: 40000 }).toBe(true);
  expect(
    await audio.evaluate((element: HTMLAudioElement) => element.paused),
  ).toBe(false);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const streams = (window as unknown as { __outroStreams: MediaStream[] })
          .__outroStreams;
        return (
          streams.length === 2 &&
          streams.every((stream) =>
            stream.getTracks().every((track) => track.readyState === "ended"),
          )
        );
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    await (
      window as unknown as { __outroContexts: AudioContext[] }
    ).__outroContexts[0].suspend();
  });
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 15000,
  });
  expect(
    await audio.evaluate((element: HTMLAudioElement) => element.paused),
  ).toBe(true);
  expect(connections).toBe(2);
  expect(tickets).toBe(2);
  await expect
    .poll(async () => (await publicRecords()).length, { timeout: 15000 })
    .toBe(2);
  const interrupted = await publicRecords();
  expect(interrupted).toHaveLength(2);
  expect(
    interrupted.every((record: { verified: boolean }) => record.verified),
  ).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
