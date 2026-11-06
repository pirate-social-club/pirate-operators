// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/karaoke-timing.test.ts; only imports changed.
import { describe, expect, test } from "./karaoke-expect.ts";

import type { KaraokeStageLine } from "../packages/karaoke/lyric-transform.ts";
import {
  clampKaraokeLinesToDuration,
  displayLines,
  getLyricDurationMs,
  KARAOKE_LINE_HOLD_MS,
} from "../packages/karaoke/karaoke-timing.ts";

function line(startMs: number, endMs: number): KaraokeStageLine {
  return {
    endMs,
    id: `line-${startMs}-${endMs}`,
    startMs,
    text: "Line",
    tokens: [
      {
        endMs,
        startMs,
        text: "Line",
      },
    ],
  };
}

describe("getLyricDurationMs", () => {
  test("uses loaded audio duration when available", () => {
    expect(getLyricDurationMs([line(0, 5000)], 3200.4)).toBe(3200);
  });

  test("falls back to the final lyric end plus hold padding", () => {
    expect(getLyricDurationMs([
      line(1000, 2400),
      line(3000, 5300),
    ])).toBe(5300 + KARAOKE_LINE_HOLD_MS);
  });

  test("returns a positive duration for empty lyrics", () => {
    expect(getLyricDurationMs([])).toBe(KARAOKE_LINE_HOLD_MS);
  });
});

describe("clampKaraokeLinesToDuration", () => {
  test("clamps an overlong final line and token to the real audio duration", () => {
    const result = clampKaraokeLinesToDuration([line(174_580, 185_940)], 182_086);

    expect(result[0]?.endMs).toBe(182_086);
    expect(result[0]?.tokens?.[0]?.endMs).toBe(182_086);
  });

  test("drops lyrics that start after the audio has ended", () => {
    expect(clampKaraokeLinesToDuration([line(6_000, 8_000)], 5_000)).toEqual([]);
  });
});

describe("displayLines", () => {
  const lines = [
    line(1_000, 4_000),
    line(5_000, 8_000),
    line(9_000, 12_000),
  ];

  test("keeps the active line and immediate next line visible during a line", () => {
    const visible = displayLines(lines, 2_000);

    expect(visible.activeLine).toBe(lines[0]);
    expect(visible.cueLine).toBeNull();
    expect(visible.nextLine).toBe(lines[1]);
  });

  test("shows only the first cue before playback starts", () => {
    const visible = displayLines(lines, 0);

    expect(visible.activeLine).toBeNull();
    expect(visible.cueLine).toBe(lines[0]);
    expect(visible.nextLine).toBeNull();
  });
});
