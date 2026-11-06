import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fixtureManifest,
  fixtureLyrics,
  sungWords,
} from "../harness/karaoke-fixture.ts";
import {
  liveLineScores,
  karaokePresentation,
} from "../services/karaoke-feedback.ts";
import {
  aggregateKaraokeSession,
  bucketRecognizedWordsIntoLines,
  scoreKaraokeLine,
} from "../packages/scoring/scoring.ts";
const manifest = fixtureManifest({
  communityId: "feedback",
  title: "fixture",
  audio: "0x00",
  lyrics: fixtureLyrics,
  artwork: "fixture",
  original: true,
});
test("live feedback reveals only committed finished lines, without private word details", () => {
  const words = sungWords(manifest);
  assert.deepEqual(liveLineScores(manifest, words, [], 1999), []);
  const lines = liveLineScores(manifest, words, [], 2000);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].lineId, "line-01");
  assert.ok(lines[0].score >= 0.9);
  assert.deepEqual(Object.keys(lines[0]).sort(), [
    "lineId",
    "score",
    "scoredLineIndex",
    "uncertain",
  ]);
});
test("measured silence is a miss, while provider failure yields no rating", () => {
  const [silent, failed] = liveLineScores(manifest, [], ["line-02"], 4500);
  assert.equal(silent.score, 0);
  assert.equal(silent.uncertain, false);
  assert.equal(failed.uncertain, true);
});
test("completion uses the existing scorer's separate lyrics and timing, with the canonical combo rule", () => {
  const scores = bucketRecognizedWordsIntoLines({
    lines: manifest.lines.map((line, i) => ({
      ...line,
      lineIndex: i,
      scoredLineIndex: i,
    })),
    words: sungWords(manifest, { wrong: ["line-03"] }),
    nowMs: 23000,
    finalizedReason: "session_end",
  }).map((bucket) => scoreKaraokeLine({ bucket }));
  const summary = aggregateKaraokeSession({ lineScores: scores });
  const view = karaokePresentation(summary, scores);
  assert.equal(view.finalScore, summary.finalScore);
  assert.equal(view.lyricsScore, summary.lyricsScore);
  assert.equal(view.timingScore, summary.timingScore);
  assert.equal(view.bestCombo, 2);
  assert.equal(view.scoredLineCount, 4);
});
