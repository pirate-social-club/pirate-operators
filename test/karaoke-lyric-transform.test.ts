// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/lyric-transform.test.ts; only imports changed.
import { describe, expect, test } from "./karaoke-expect.ts";

import { toKaraokeStageLines } from "../packages/karaoke/lyric-transform.ts";

describe("toKaraokeStageLines", () => {
  test("drops invalid lines, coerces timing fields, and sorts by start time", () => {
    const lines = toKaraokeStageLines([
      { id: "late", text: "Late line", start_ms: "5000", end_ms: "7000" },
      { id: "blank", text: " ", start_ms: 1000, end_ms: 2000 },
      { id: "seconds", text: "Seconds line", start: "1.5", end: "3.25" },
      { id: "inverted", text: "Bad timing", start_ms: 9000, end_ms: 8000 },
    ]);

    expect(lines.map((line) => line.id)).toEqual(["seconds", "late"]);
    expect(lines[0].startMs).toBe(1500);
    expect(lines[0].endMs).toBe(3250);
  });

  test("uses valid word timings and drops empty or partial words", () => {
    const [line] = toKaraokeStageLines([
      {
        id: "words",
        text: "Only real words",
        start_ms: 1000,
        end_ms: 4000,
        words: [
          { text: "Only", start_ms: 1000, end_ms: 1600 },
          { text: " ", start_ms: 1600, end_ms: 1700 },
          { text: "real", start_ms: 1700, end_ms: 2600 },
          { text: "words" },
          { text: "words", start_ms: 2600, end_ms: 4000 },
        ],
      },
    ]);

    expect(line.tokens?.map((token) => token.text)).toEqual(["Only", "real", "words"]);
    expect(line.tokens?.map((token) => token.trailing)).toEqual([" ", " ", ""]);
  });

  test("falls back to a whole-line token when no usable words exist", () => {
    const [line] = toKaraokeStageLines([
      {
        id: "fallback",
        text: "Whole line",
        start_ms: 2000,
        end_ms: 5000,
        words: [
          { text: "Whole" },
          { text: "line" },
        ],
      },
    ]);

    expect(line.tokens).toEqual([
      {
        endMs: 5000,
        startMs: 2000,
        text: "Whole line",
        trailing: "",
      },
    ]);
  });

  test("keeps CJK character tokens adjacent", () => {
    const [line] = toKaraokeStageLines([
      {
        id: "cjk",
        text: "海风",
        start_ms: 1000,
        end_ms: 2000,
        words: [
          { text: "海", start_ms: 1000, end_ms: 1500 },
          { text: "风", start_ms: 1500, end_ms: 2000 },
        ],
      },
    ]);

    expect(line.tokens?.map((token) => token.trailing)).toEqual(["", ""]);
  });

  test("drops zero-duration words and falls back to the whole line", () => {
    const [line] = toKaraokeStageLines([
      {
        id: "zero-word",
        text: "Hold it",
        start_ms: 0,
        end_ms: 1200,
        words: [
          { text: "Hold", start_ms: 0, end_ms: 0 },
        ],
      },
    ]);

    expect(line.tokens).toEqual([
      {
        endMs: 1200,
        startMs: 0,
        text: "Hold it",
        trailing: "",
      },
    ]);
  });

  test("falls back when words is not an array", () => {
    const [line] = toKaraokeStageLines([
      {
        id: "bad-words",
        text: "Still works",
        start_ms: "0",
        end_ms: "1500",
        words: { text: "Still", start_ms: 0, end_ms: 500 },
      },
    ]);

    expect(line.startMs).toBe(0);
    expect(line.tokens?.[0]?.text).toBe("Still works");
  });

  test("makes duplicate ids unique", () => {
    const lines = toKaraokeStageLines([
      { id: "repeat", text: "First", start_ms: 0, end_ms: 1000 },
      { id: "repeat", text: "Second", start_ms: 1200, end_ms: 2200 },
    ]);

    expect(lines.map((line) => line.id)).toEqual(["repeat", "repeat-1"]);
  });

  test("keeps contraction fragments attached", () => {
    const [line] = toKaraokeStageLines([
      {
        id: "contraction",
        text: "I'm here",
        start_ms: 0,
        end_ms: 1600,
        words: [
          { text: "I", start_ms: 0, end_ms: 300 },
          { text: "'m", start_ms: 300, end_ms: 700 },
          { text: "here", start_ms: 700, end_ms: 1600 },
        ],
      },
    ]);

    expect(line.tokens?.map((token) => token.trailing)).toEqual(["", " ", ""]);
  });

  test("preserves canonical spacing around quoted phrases and parentheticals", () => {
    const [line] = toKaraokeStageLines([
      {
        id: "punctuation",
        text: "Lead \"quoted words\" (aside) end",
        start_ms: 0,
        end_ms: 3_000,
        words: [
          { text: "Lead", start_ms: 0, end_ms: 300 },
          { text: "\"quoted", start_ms: 300, end_ms: 700 },
          { text: "words\"", start_ms: 700, end_ms: 1_200 },
          { text: "(aside)", start_ms: 1_200, end_ms: 1_800 },
          { text: "end", start_ms: 1_800, end_ms: 3_000 },
        ],
      },
    ]);

    expect(line.tokens?.map((token) => token.trailing)).toEqual([" ", " ", " ", " ", ""]);
    expect(line.tokens?.map((token) => `${token.text}${token.trailing}`).join(""))
      .toBe("Lead \"quoted words\" (aside) end");
  });

  test("uses canonical lyric characters while retaining provider timings", () => {
    const [line] = toKaraokeStageLines([
      {
        id: "lookalike",
        text: "Every word",
        start_ms: 0,
        end_ms: 1_600,
        words: [
          { text: "Evеry", start_ms: 0, end_ms: 800 },
          { text: "word", start_ms: 800, end_ms: 1_600 },
        ],
      },
    ]);

    expect(line.tokens).toEqual([
      { endMs: 800, startMs: 0, text: "Every", trailing: " " },
      { endMs: 1_600, startMs: 800, text: "word", trailing: "" },
    ]);
  });

  test("folds the same Cyrillic lookalikes as ingestion", () => {
    const [line] = toKaraokeStageLines([
      {
        id: "line-lookalike-y",
        start_ms: 0,
        end_ms: 500,
        text: "you",
        words: [{ start_ms: 0, end_ms: 500, text: "уou" }],
      },
    ]);

    expect(line?.tokens).toEqual([{ startMs: 0, endMs: 500, text: "you", trailing: "" }]);
  });

  test("preserves CJK tokens through canonical alignment", () => {
    const [line] = toKaraokeStageLines([
      {
        id: "cjk-canonical",
        text: "海风",
        start_ms: 0,
        end_ms: 1_000,
        words: [
          { text: "海", start_ms: 0, end_ms: 500 },
          { text: "风", start_ms: 500, end_ms: 1_000 },
        ],
      },
    ]);

    expect(line.tokens?.map((token) => token.trailing)).toEqual(["", ""]);
  });

  test("groups token-stream alignment output into lyric lines", () => {
    const lines = toKaraokeStageLines([
      { text: "[Intro]", start: 0.1, end: 10.34 },
      { text: "\n", start: 10.34, end: 10.41 },
      { text: "[Verse 1]", start: 10.42, end: 20.82 },
      { text: "\n", start: 20.82, end: 20.92 },
      { text: "In", start: 20.92, end: 21.22 },
      { text: " ", start: 21.22, end: 21.26 },
      { text: "a", start: 21.26, end: 21.3 },
      { text: " ", start: 21.3, end: 21.36 },
      { text: "house", start: 21.36, end: 21.66 },
      { text: "\n", start: 21.66, end: 21.72 },
      { text: "Old", start: 45.2, end: 45.5 },
      { text: " ", start: 45.5, end: 45.55 },
      { text: "guitar", start: 45.55, end: 46.1 },
    ]);

    expect(lines.map((line) => line.text)).toEqual(["In a house", "Old guitar"]);
    expect(lines[0]?.startMs).toBe(20920);
    expect(lines[0]?.endMs).toBe(21660);
    expect(lines[0]?.tokens?.map((token) => token.trailing)).toEqual([" ", " ", ""]);
  });

  test("drops ad-libs from token-stream alignment output", () => {
    const lines = toKaraokeStageLines([
      { text: "(Ooh)", start: 1, end: 1.5 },
      { text: " ", start: 1.5, end: 1.6 },
      { text: "(ooh)", start: 1.6, end: 2 },
      { text: "\n", start: 2, end: 2.1 },
      { text: "Lead", start: 2.1, end: 2.5 },
      { text: " ", start: 2.5, end: 2.6 },
      { text: "line", start: 2.6, end: 3 },
    ]);

    expect(lines.map((line) => line.text)).toEqual(["Lead line"]);
  });

  test("drops section cue lines from the sung lyric stage", () => {
    const lines = toKaraokeStageLines([
      {
        end_ms: 10_000,
        id: "section-intro",
        index: 0,
        kind: "section",
        start_ms: 0,
        text: "[Intro]",
        words: [],
      },
      {
        end_ms: 12_000,
        id: "lyric-first",
        index: 1,
        kind: "lyric",
        start_ms: 10_000,
        text: "First lyric",
        words: [
          { end_ms: 10_500, start_ms: 10_000, text: "First" },
          { end_ms: 12_000, start_ms: 10_500, text: "lyric" },
        ],
      },
    ]);

    expect(lines.map((line) => line.text)).toEqual(["First lyric"]);
  });

  test("drops ad-libs before active-line and next-line selection", () => {
    const lines = toKaraokeStageLines([
      {
        end_ms: 1_000,
        id: "lyric-first",
        index: 0,
        kind: "lyric",
        start_ms: 0,
        text: "First lyric",
        words: [{ end_ms: 1_000, start_ms: 0, text: "First lyric" }],
      },
      {
        end_ms: 2_000,
        id: "adlib-ooh",
        index: 1,
        kind: "adlib",
        start_ms: 1_000,
        text: "(Ooh)",
        words: [{ end_ms: 2_000, start_ms: 1_000, text: "(Ooh)" }],
      },
      {
        end_ms: 3_000,
        id: "lyric-next",
        index: 2,
        kind: "lyric",
        start_ms: 2_000,
        text: "Next lyric",
        words: [{ end_ms: 3_000, start_ms: 2_000, text: "Next lyric" }],
      },
    ]);

    expect(lines.map((line) => line.text)).toEqual(["First lyric", "Next lyric"]);
  });
});
