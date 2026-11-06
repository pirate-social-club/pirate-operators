import { test } from "node:test";
import assert from "node:assert/strict";
import { ScoringResponseWatch } from "../src/karaoke/scoring-response-watch.ts";

test("long intros and instrumental gaps do not require nonexistent scores", () => {
  const watch = new ScoringResponseWatch();
  for (const now of [0, 10000, 120000])
    assert.equal(
      watch.expired({ playing: true, expected: 0, received: 0, now }),
      false,
    );
  assert.equal(
    watch.expired({ playing: true, expected: 1, received: 1, now: 180000 }),
    false,
  );
});

test("missing expected feedback expires after ten seconds, and new server progress resets that wait", () => {
  const watch = new ScoringResponseWatch();
  const observe = (now: number, received = 0) =>
    watch.expired({ playing: true, expected: 3, received, now });
  assert.equal(observe(1000), false);
  assert.equal(observe(10999), false);
  assert.equal(observe(11000), true);
  assert.equal(observe(11001, 1), false);
  assert.equal(observe(21000, 1), false);
  assert.equal(observe(21001, 1), true);
});

test("paused, interrupted, seeking and reloaded playback gets a fresh response window", () => {
  const watch = new ScoringResponseWatch();
  const observe = (now: number, playing = true) =>
    watch.expired({ playing, expected: 2, received: 0, now });
  assert.equal(observe(0), false);
  assert.equal(observe(9000, false), false);
  assert.equal(observe(900000, false), false);
  assert.equal(observe(900001), false);
  assert.equal(observe(910000), false);
  watch.reset(); // seek or new take
  assert.equal(observe(999999), false);
  assert.equal(
    new ScoringResponseWatch().expired({
      playing: true,
      expected: 2,
      received: 0,
      now: 1000000,
    }),
    false,
  );
});
