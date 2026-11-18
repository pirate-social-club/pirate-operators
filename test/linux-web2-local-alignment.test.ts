import assert from "node:assert/strict";
import test from "node:test";
import { alignmentResult } from "../packages/alignment/elevenlabs-response.ts";
import { hashText } from "../packages/community/common.ts";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import { localAlignmentReplay } from "../services/linux-web2-local-alignment.ts";

const post = {
  chainId: 6343,
  postsContract: "0x1111111111111111111111111111111111111111" as const,
  communityId: hashText("selected fixture community"),
  postId: hashText("selected fixture post"),
};
const fixture = () => ({
  characters: [
    { text: "a", start: 0, end: 0.5 },
    { text: "\r", start: 0.5, end: 0.56 },
    { text: "\n", start: 0.56, end: 0.6 },
    { text: "b", start: 0.6, end: 1.1 },
  ],
  words: [{ text: "a b", start: 0, end: 1.1, loss: 0 }],
  loss: 0.01,
});

test("local archival replay preserves original bytes and feeds LF character timings to the production parser", () => {
  const raw = fixture();
  const originalBytes = JSON.stringify(raw);
  const lyrics = createLyrics(post, "a\nb", "en");
  assert.throws(() => alignmentResult({ ...raw, words: [] }, lyrics, 1500), /alignment_transcript_mismatch/);
  const replay = localAlignmentReplay(raw, lyrics.sourceText);
  assert.deepEqual(replay.characters, [
    raw.characters[0], { text: "\n", start: 0.5, end: 0.6 }, raw.characters[3],
  ]);
  const result = alignmentResult(replay, lyrics, 1500);
  assert.equal(result.mode, "character");
  assert.deepEqual(result.words.map(w => [w.lineId, w.text, w.startMs, w.endMs]), [
    [lyrics.lines[0]!.lineId, "a", 0, 500], [lyrics.lines[1]!.lineId, "b", 600, 1100],
  ]);
  assert.equal(JSON.stringify(raw), originalBytes);
});

test("exact CRLF is preserved and changed original text or delimiter time is refused", () => {
  const raw = fixture();
  const lyrics = createLyrics(post, "a\r\nb", "en");
  const replay = localAlignmentReplay(raw, lyrics.sourceText);
  assert.deepEqual(replay.characters, raw.characters);
  assert.equal(alignmentResult(replay, lyrics, 1500).mode, "character");
  assert.throws(() => localAlignmentReplay(raw, "a\nc"), /karaoke_alignment_archive_transcript_changed/);
  raw.characters[1]!.end = 0.55;
  assert.throws(() => localAlignmentReplay(raw, "a\nb"), /karaoke_alignment_archive_delimiter_changed/);
});
