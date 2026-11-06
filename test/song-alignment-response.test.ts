import test from "node:test";
import assert from "node:assert/strict";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import {
  alignmentResult,
  alignmentWords,
  isSectionCue,
} from "../packages/alignment/elevenlabs-response.ts";

const identity = {
  chainId: 31337,
  postsContract: "0x1111111111111111111111111111111111111111" as const,
  communityId: `0x${"22".repeat(32)}` as `0x${string}`,
  postId: `0x${"33".repeat(32)}` as `0x${string}`,
};
function response(text: string) {
  const characters = Array.from(text).map((text, i) => ({
    text,
    start: i / 10,
    end: (i + 1) / 10,
  }));
  const words = [...text.matchAll(/\S+/gu)].map((m) => ({
    text: m[0],
    start: m.index / 10,
    end: (m.index + m[0].length) / 10,
    loss: 0.2,
  }));
  return { characters, words, loss: 0.2 };
}
test("alignment retains repeated lyric occurrence IDs and excludes section cues", () => {
  const lyrics = createLyrics(
    identity,
    "[Verse 1]\nBaby blues\n\nBaby blues",
    "en",
  );
  const result = alignmentWords(response(lyrics.sourceText), lyrics, 10000);
  assert.deepEqual(
    result.map((w) => w.text),
    ["Baby", "blues", "Baby", "blues"],
  );
  assert.deepEqual(
    result.map((w) => w.lineId),
    [
      lyrics.lines[1]!.lineId,
      lyrics.lines[1]!.lineId,
      lyrics.lines[2]!.lineId,
      lyrics.lines[2]!.lineId,
    ],
  );
  assert.deepEqual(
    result.map((w) => w.wordIndex),
    [0, 1, 0, 1],
  );
  assert.notEqual(lyrics.lines[1]!.lineId, lyrics.lines[2]!.lineId);
  assert.equal(result[0]!.startMs, 1000);
});
test("alignment rejects a changed transcript, incomplete words and extra fields", () => {
  const lyrics = createLyrics(identity, "Baby blues", "en"),
    good = response(lyrics.sourceText);
  const changed = structuredClone(good);
  changed.characters[0]!.text = "M";
  assert.throws(
    () => alignmentWords(changed, lyrics, 10000),
    /alignment_transcript_mismatch/,
  );
  // Unbound words fall back to the character timings, as in the centralized
  // adapter, so an incomplete word list is not a failure on its own.
  const incomplete = structuredClone(good);
  incomplete.words.pop();
  assert.equal(alignmentResult(incomplete, lyrics, 10000).mode, "character");
  const cueOnly = createLyrics(identity, "[Intro]", "en");
  assert.throws(
    () => alignmentWords(response(cueOnly.sourceText), cueOnly, 10000),
    /incomplete_alignment_words/,
  );
  assert.throws(() =>
    alignmentWords({ ...good, original: true }, lyrics, 10000),
  );
});
test("alignment rejects reordered or out-of-duration timings and mismatched word spans", () => {
  const lyrics = createLyrics(identity, "Baby blues", "en"),
    good = response(lyrics.sourceText);
  const reordered = structuredClone(good);
  reordered.characters[3]!.start = 0;
  assert.throws(
    () => alignmentWords(reordered, lyrics, 10000),
    /reordered_alignment_timing/,
  );
  assert.throws(
    () => alignmentWords(good, lyrics, 100),
    /invalid_alignment_timing/,
  );
  const span = structuredClone(good);
  span.words[0]!.end = 0.1;
  const fallback = alignmentResult(span, lyrics, 10000);
  assert.equal(fallback.mode, "character");
  assert.deepEqual(
    fallback.words.map((w) => [w.text, w.startMs, w.endMs]),
    [
      ["Baby", 0, 400],
      ["blues", 500, 1000],
    ],
  );
});
test("alignment permits only the centralized five-millisecond quantization overlap", () => {
  const lyrics = createLyrics(identity, "Baby", "en"),
    good = response(lyrics.sourceText);
  good.characters[1]!.start = 0.096;
  const aligned = alignmentWords(good, lyrics, 10000);
  assert.equal(aligned[0]!.endMs, 400);
  good.characters[1]!.start = 0.094;
  assert.throws(
    () => alignmentWords(good, lyrics, 10000),
    /reordered_alignment_timing/,
  );
});
test("alignment maps bare CR, CRLF, blank lines and repetitions to the exact retained occurrences", () => {
  for (const source of ["Baby\rblues", "Baby\r\n\r\nblues\nBaby"]) {
    const lyrics = createLyrics(identity, source, "en"),
      words = alignmentWords(response(source), lyrics, 10000);
    assert.equal(lyrics.sourceText, source);
    assert(
      words.every((word) =>
        lyrics.lines.some(
          (line) =>
            line.lineId === word.lineId &&
            line.lineVersion === word.lineVersion,
        ),
      ),
    );
    assert.deepEqual(
      words.map((w) => w.lineId),
      source.includes("\r\n")
        ? lyrics.lines.map((line) => line.lineId)
        : [lyrics.lines[0]!.lineId, lyrics.lines[0]!.lineId],
    );
  }
});
test("character-only alignment groups characters at whitespace on the retained occurrences", () => {
  const lyrics = createLyrics(
      identity,
      "[Verse 1]\nHold on\n(Instrumental)\nHold on",
      "en",
    ),
    good = response(lyrics.sourceText),
    words = alignmentResult({ ...good, words: [] }, lyrics, 10000);
  assert.equal(words.mode, "character");
  assert.deepEqual(
    words.words.map((w) => [w.lineId, w.wordIndex, w.text, w.startMs, w.endMs]),
    [
      [lyrics.lines[1]!.lineId, 0, "Hold", 1000, 1400],
      [lyrics.lines[1]!.lineId, 1, "on", 1500, 1700],
      [lyrics.lines[3]!.lineId, 0, "Hold", 3300, 3700],
      [lyrics.lines[3]!.lineId, 1, "on", 3800, 4000],
    ],
  );
  // Word timings that do bind keep word mode with the same occurrences.
  const bound = alignmentResult(good, lyrics, 10000);
  assert.equal(bound.mode, "word");
  assert.deepEqual(
    bound.words.map((w) => w.lineId),
    words.words.map((w) => w.lineId),
  );
});
test("character fallback refuses mixed whitespace entries and words across lines", () => {
  const lyrics = createLyrics(identity, "Hold on\nBaby", "en"),
    good = response(lyrics.sourceText);
  const mixed = structuredClone(good);
  mixed.characters.splice(3, 2, { text: "d ", start: 0.3, end: 0.5 });
  assert.throws(
    () => alignmentResult({ ...mixed, words: [] }, lyrics, 10000),
    /invalid_alignment_character/,
  );
  const across = structuredClone(good);
  across.words = [
    { text: "Hold", start: 0, end: 0.4, loss: 0 },
    { text: "on", start: 0.5, end: 0.7, loss: 0 },
    { text: "Baby", start: 0.8, end: 1.2, loss: 0 },
  ];
  assert.equal(alignmentResult(across, lyrics, 10000).mode, "word");
  assert.equal(isSectionCue("[Chorus]"), true);
  assert.equal(isSectionCue("(Instrumental solo)"), true);
  assert.equal(isSectionCue("[a [b]"), false);
  assert.equal(isSectionCue("Hold on"), false);
});
