import { test } from "node:test";
import assert from "node:assert/strict";
import { positionPlaybackWhenReady } from "../src/karaoke/playback-position.ts";

class Audio extends EventTarget {
  readyState = 0;
  duration = NaN;
  currentTime = 0;
  metadata() {
    // Model the browser discarding its default pre-metadata start position.
    this.currentTime = 0;
    this.duration = 175;
    this.readyState = 1;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
  canPlay() {
    this.readyState = 3;
    this.dispatchEvent(new Event("canplay"));
  }
}

test("delayed metadata restores the current elapsed position before playback", () => {
  const audio = new Audio();
  let elapsed = 43000;
  positionPlaybackWhenReady(audio, () => elapsed);
  elapsed += 2500;
  audio.metadata();
  assert.equal(audio.currentTime, 0, "metadata alone is too early to seek");
  audio.canPlay();
  assert.equal(audio.currentTime, 45.5);
  audio.currentTime = 50;
  audio.dispatchEvent(new Event("loadedmetadata"));
  assert.equal(audio.currentTime, 50, "a later event cannot rewind playback");
});

test("cancellation prevents a stale resume from seeking a replaced take", () => {
  const audio = new Audio();
  const cancel = positionPlaybackWhenReady(audio, () => 43000);
  cancel();
  audio.metadata();
  audio.canPlay();
  assert.equal(audio.currentTime, 0);
});

test("already loaded audio seeks immediately and clamps an expired resume to the end", () => {
  const audio = new Audio();
  audio.metadata();
  audio.canPlay();
  positionPlaybackWhenReady(audio, () => 43000);
  assert.equal(audio.currentTime, 43);
  positionPlaybackWhenReady(audio, () => 200000);
  assert.equal(audio.currentTime, 175);
});
