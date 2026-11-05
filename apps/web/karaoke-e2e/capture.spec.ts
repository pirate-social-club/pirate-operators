import { expect, test, type Page } from "@playwright/test";
import { capturedWords } from "./capture-fixture.ts";

interface Operator {
  words: { text: string; startMs: number; endMs: number }[];
  attempt: { generation: number; ended?: { status: string } | null } | null;
  simulator: {
    minted: number;
    streams: {
      params: Record<string, string>;
      chunks: number;
      audioMs: number;
      sampleRates: number[];
    }[];
  };
}
const operator = async (page: Page) =>
  (await (await page.request.get("/__fixture/operator")).json()) as Operator;
const playing = (page: Page) =>
  page.evaluate(() => !document.querySelector("audio")!.paused);
const songMs = (page: Page) =>
  page.evaluate(() => document.querySelector("audio")!.currentTime * 1000);
/** Song-time offset of each stored word from its provider stream time. */
const offsets = (o: Operator) =>
  o.words.map((w, i) => w.startMs - capturedWords[i].start * 1000);

const consoleLines: string[] = [];
const media = (page: Page) =>
  page.evaluate(() => {
    const audio = document.querySelector("audio")!;
    return {
      currentTime: audio.currentTime,
      paused: audio.paused,
      readyState: audio.readyState,
      state: (globalThis as any).karaokeAcceptance.state(),
      context: (globalThis as any).karaokeAcceptance.context?.() ?? null,
    };
  });
async function sing(page: Page, during?: () => Promise<void>) {
  page.on("console", (message) =>
    consoleLines.push(`${message.type()}: ${message.text()}`),
  );
  const before = (await operator(page)).simulator;
  await page.goto("/");
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect.poll(() => playing(page), { timeout: 15000 }).toBe(true);
  await during?.();
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 20000,
  });
  await expect
    .poll(async () => (await operator(page)).attempt?.ended?.status ?? null, {
      timeout: 15000,
      message: `take did not end: ${JSON.stringify(await page.evaluate(() => (globalThis as any).karaokeAcceptance.state()))}`,
    })
    .toBe("completed")
    .catch(async (error) => {
      const o = await operator(page);
      throw new Error(
        `${error.message}\noperator: ${JSON.stringify({ attempt: o.attempt, words: o.words.length, sim: o.simulator.streams.map((s) => [s.chunks, s.commits]) })}`,
      );
    });
  await expect
    .poll(async () => (await operator(page)).words.length, { timeout: 10000 })
    .toBe(capturedWords.length);
  const o = await operator(page);
  // Provider streams and tokens opened by this take alone.
  return {
    ...o,
    minted: o.simulator.minted - before.minted,
    streams: o.simulator.streams.slice(before.streams.length),
  };
}

test("microphone audio reaches the operator through its provider and is stored at song time", async ({
  page,
}) => {
  const o = await sing(page);
  expect(o.minted).toBe(1);
  expect(o.streams).toHaveLength(1);
  const stream = o.streams[0];
  expect(stream.sampleRates).toEqual([16000]);
  expect(stream.params.audio_format).toBe("pcm_16000");
  expect(stream.chunks).toBeGreaterThan(50);
  // Roughly the take's song span: capture starts once the track is playing.
  expect(stream.audioMs).toBeGreaterThan(6000);
  expect(stream.audioMs).toBeLessThan(8200);
  expect(o.words.map((w) => w.text)).toEqual(capturedWords.map((w) => w.text));
  // One continuous capture epoch: every word sits at the same song offset,
  // the song position at which the first chunk was captured.
  const shift = offsets(o);
  // Interpolation and millisecond rounding allow a few ms either side of capture start.
  expect(Math.min(...shift)).toBeGreaterThan(-50);
  expect(Math.max(...shift)).toBeLessThan(1500);
  expect(Math.max(...shift) - Math.min(...shift)).toBeLessThan(60);
});

test("a dropped connection reconnects and capture resumes on a fresh anchor without replaying audio", async ({
  page,
}) => {
  const o = await sing(page, async () => {
    await expect
      .poll(() => songMs(page), { timeout: 10000 })
      .toBeGreaterThan(2500)
      .catch(async (error) => {
        throw new Error(
          `${error.message}\nmedia: ${JSON.stringify(await media(page))}\nconsole: ${consoleLines.join(" | ")}`,
        );
      });
    await page.evaluate(() =>
      (globalThis as any).karaokeAcceptance.dropSocket(),
    );
    await expect
      .poll(() =>
        page.evaluate(() => (globalThis as any).karaokeAcceptance.status()),
      )
      .toBe("active");
  });
  expect(o.attempt?.generation).toBe(2);
  // The take keeps one provider stream across the learner's reconnect.
  expect(o.minted).toBe(1);
  expect(o.streams).toHaveLength(1);
  const shift = offsets(o);
  const before = shift.slice(0, 2);
  const after = shift.slice(5);
  // Audio during the gap is dropped, not replayed: later words sit later in
  // the song by at least the reconnect backoff.
  expect(Math.min(...after) - Math.max(...before)).toBeGreaterThan(200);
});
