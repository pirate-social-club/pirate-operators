import assert from "node:assert/strict";
import { test } from "node:test";
import {
  karaokeStageLinesOf,
  type KaraokeTimedLine,
} from "../packages/karaoke/manifest-lines.ts";
import { displayLines } from "../packages/karaoke/karaoke-timing.ts";
import type { ManifestLine } from "../packages/protocol/payments.ts";

const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const line = (
  ordinal: number,
  text: string,
  words: [string, number, number][],
): ManifestLine => ({
  lineId: id(ordinal),
  lineVersion: 1,
  ordinal,
  text,
  startMs: words[0]?.[1] ?? ordinal * 1000,
  endMs: words.at(-1)?.[2] ?? ordinal * 1000 + 900,
  words: words.map(([text, startMs, endMs]) => ({ text, startMs, endMs })),
});

test("protocol lines keep their published IDs, order and word ranges", () => {
  const stage = karaokeStageLinesOf([
    line(2, "Don't stop now", [
      ["Don't", 3000, 3600],
      ["stop", 3700, 4200],
      ["now", 4300, 4900],
    ]),
    line(1, "Hello, world!", [
      ["Hello", 500, 1200],
      ["world", 1300, 2400],
    ]),
  ]);
  assert.deepEqual(
    stage.map((l) => l.id),
    [id(1), id(2)],
  );
  assert.deepEqual(
    stage[1].tokens.map(({ text, startMs, endMs }) => [text, startMs, endMs]),
    [
      ["Don't", 3000, 3600],
      ["stop", 3700, 4200],
      ["now", 4300, 4900],
    ],
  );
  // Provider words without punctuation map back onto the canonical text.
  assert.deepEqual(
    stage[0].tokens.map((t) => [t.text, t.trailing]),
    [
      ["Hello", ", "],
      ["world", ""],
    ],
  );
});

test("a line without word timings is one token spanning the line", () => {
  const [only] = karaokeStageLinesOf([line(1, "Hum along", [])]);
  assert.deepEqual(only.tokens, [
    { text: "Hum along", startMs: 1000, endMs: 1900, trailing: "" },
  ]);
});

test("repeated chorus lines stay distinct by published line ID", () => {
  const stage = karaokeStageLinesOf([
    line(1, "Oh oh", [
      ["Oh", 100, 300],
      ["oh", 400, 600],
    ]),
    line(2, "Oh oh", [
      ["Oh", 1100, 1300],
      ["oh", 1400, 1600],
    ]),
  ]);
  assert.deepEqual(
    stage.map((l) => l.id),
    [id(1), id(2)],
  );
  assert.equal(displayLines(stage, 1200).activeLine?.id, id(2));
});

test("the protocol manifest line stays assignable to the display's timed line", () => {
  // Compile-time check under the root typecheck; the browser build declares
  // these fields structurally to avoid the protocol's chain libraries.
  const asTimed = (
    lines: readonly ManifestLine[],
  ): readonly KaraokeTimedLine[] => lines;
  const lines = [
    line(1, "Hold on", [
      ["Hold", 0, 400],
      ["on", 500, 900],
    ]),
  ];
  assert.equal(asTimed(lines), lines);
});
