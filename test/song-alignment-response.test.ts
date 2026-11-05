import test from "node:test";
import assert from "node:assert/strict";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import { alignmentWords } from "../packages/alignment/elevenlabs-response.ts";

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
  const incomplete = structuredClone(good);
  incomplete.words.pop();
  assert.throws(
    () => alignmentWords(incomplete, lyrics, 10000),
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
  assert.throws(
    () => alignmentWords(span, lyrics, 10000),
    /alignment_word_character_mismatch/,
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
