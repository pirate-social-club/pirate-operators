import { expect, test } from "@playwright/test";

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
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Sing", exact: true }).click();
  await page
    .getByRole("button", { name: "Start karaoke", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Enable public learning results" })
    .getByRole("button", { name: "Continue", exact: true })
    .click();
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
  const records = await (
    await page.request.get("/__fixture/records?learner=9")
  ).json();
  expect(records).toHaveLength(1);
  expect(records[0].verified, records[0].problems.join(", ")).toBe(true);
  expect(records[0].lines).toHaveLength(23);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The same enrollment permits another take. A suspended playback context
  // after capture has ended must expose the result, without reopening capture.
  closed = false;
  await page.getByRole("button", { name: "Sing again", exact: true }).click();
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
  const interrupted = await (
    await page.request.get("/__fixture/records?learner=9")
  ).json();
  expect(interrupted).toHaveLength(2);
  expect(
    interrupted.every((record: { verified: boolean }) => record.verified),
  ).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
