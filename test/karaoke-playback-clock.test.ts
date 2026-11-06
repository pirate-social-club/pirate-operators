// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-playback-clock.test.ts; only imports changed.
import { describe, expect, test } from "./karaoke-expect.ts";
import { KaraokePlaybackClock } from "../packages/karaoke/playback-clock.ts";

describe("sample capture to actual playback mapping", () => {
  test("follows the measured 0.8 playback rate without building a five-second lead", () => {
    const clock = new KaraokePlaybackClock();
    for (let captureMs = 0; captureMs <= 25_000; captureMs += 50) {
      clock.observe({ captureMs, songMs: captureMs * 0.8 });
    }
    expect(clock.mapRange(24_900, 25_000)).toEqual({ songStartMs: 19_920, songEndMs: 20_000 });
  });

  test("follows later capture-clock drift independently of normal playback", () => {
    const clock = new KaraokePlaybackClock();
    clock.observe({ captureMs: 0, songMs: 0 });
    clock.observe({ captureMs: 9_900, songMs: 10_000 });
    expect(clock.mapRange(9_801, 9_900)?.songStartMs).toBeCloseTo(9_900);
    expect(clock.mapRange(9_801, 9_900)?.songEndMs).toBe(10_000);
  });

  test("maps queued samples to their earlier capture interval after playback has resumed", () => {
    const clock = new KaraokePlaybackClock();
    clock.observe({ captureMs: 0, songMs: 0 });
    clock.observe({ captureMs: 1_000, songMs: 800 });
    clock.observe({ captureMs: 2_000, songMs: 800 });
    clock.observe({ captureMs: 3_000, songMs: 1_800 });
    expect(clock.mapRange(900, 1_000)).toEqual({ songStartMs: 720, songEndMs: 800 });
    expect(clock.mapRange(1_500, 1_600)).toEqual({ songStartMs: 800, songEndMs: 800 });
  });

  test("requires a fresh epoch for backward seeks and rejects stale queued samples", () => {
    const clock = new KaraokePlaybackClock();
    clock.observe({ captureMs: 5_000, songMs: 10_000 });
    clock.observe({ captureMs: 5_100, songMs: 10_100 });
    clock.reset({ captureMs: 5_200, songMs: 2_000 });
    clock.observe({ captureMs: 5_300, songMs: 2_100 });
    expect(clock.mapRange(5_100, 5_200)).toBeNull();
    expect(clock.mapRange(5_200, 5_300)).toEqual({ songStartMs: 2_000, songEndMs: 2_100 });
  });

  test("does not invent a clock rate or extend a stale observation indefinitely", () => {
    const clock = new KaraokePlaybackClock(1_000);
    clock.observe({ captureMs: 0, songMs: 0 });
    expect(clock.mapRange(0, 100)).toBeNull();
    clock.observe({ captureMs: 100, songMs: 100 });
    expect(clock.mapRange(100, 300)).toBeNull();
    clock.observe({ captureMs: 2_000, songMs: 2_000 });
    clock.observe({ captureMs: 2_100, songMs: 2_100 });
    expect(clock.mapRange(0, 100)).toBeNull();
  });
});
