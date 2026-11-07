import { expect, test } from "@playwright/test";

test("scoring releases the microphone while the outro plays to its natural end", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    Object.assign(window, { __outroStreams: streams });
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
  page.on("request", (request) => {
    if (request.url().endsWith("/api/karaoke/tickets")) tickets++;
  });
  page.on("websocket", (socket) => {
    connections++;
    socket.on("framereceived", ({ payload }) => {
      if (
        typeof payload === "string" &&
        JSON.parse(payload).code === "attempt_closed"
      )
        closed = true;
    });
  });
  await page.goto("/?learner=5");
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
    (value: { ended: boolean }) => value.ended,
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
    await page.request.get("/__fixture/records?learner=5")
  ).json();
  expect(records).toHaveLength(1);
  expect(records[0].verified, records[0].problems.join(", ")).toBe(true);
  expect(records[0].lines).toHaveLength(23);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
