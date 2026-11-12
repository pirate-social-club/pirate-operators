// UNRUN. Media facts, not optimistic visual state.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mediaFacts,
  seekMedia,
  timeLabel,
} from "../src/shell/player/media-state.ts";
test("unknown/infinite metadata never becomes a fictitious track duration", () => {
  assert.equal(
    mediaFacts({ readyState: 0, duration: NaN, currentTime: 0 }).duration,
    undefined,
  );
  assert.equal(
    mediaFacts({ readyState: 1, duration: Infinity, currentTime: 12 }).duration,
    undefined,
  );
  assert.equal(timeLabel(undefined), "--:--");
  assert.equal(timeLabel(65.7), "1:05");
});
test("seeking is refused without metadata and clamps a real finite track", () => {
  const media = { readyState: 0, duration: NaN, currentTime: 0 };
  assert.equal(seekMedia(media, 2000), false);
  assert.equal(media.currentTime, 0);
  media.readyState = 1;
  media.duration = 10;
  assert.equal(seekMedia(media, 4000), true);
  assert.equal(media.currentTime, 4);
  seekMedia(media, 20000);
  assert.equal(media.currentTime, 10);
  seekMedia(media, -200);
  assert.equal(media.currentTime, 0);
  assert.equal(seekMedia(media, NaN), false);
});
