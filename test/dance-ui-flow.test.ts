import test from "node:test";
import assert from "node:assert/strict";
import { createDanceReviewObserver } from "../apps/web/src/dance/review-observer.ts";
import { danceNeedsObservation } from "../apps/web/src/dance/presentation.ts";
import { danceFixture } from "./dance-fixture.ts";

function fixture(refresh: (id: string) => Promise<void> = async () => {}) {
  let visible = true;
  let current = true;
  let sequence = 0;
  let rested = 0;
  const timers = new Map<number, { use: () => void; delay: number }>();
  const observer = createDanceReviewObserver({
    visible: () => visible,
    current: () => current,
    refresh,
    schedule: (use, delay) => {
      const id = ++sequence;
      timers.set(id, { use, delay });
      return id;
    },
    cancel: (id) => timers.delete(id as number),
    rested: () => {
      rested++;
    },
  });
  return {
    observer,
    timers,
    rested: () => rested,
    visible: (value: boolean) => {
      visible = value;
    },
    current: (value: boolean) => {
      current = value;
    },
    fire: async () => {
      const [id, entry] = timers.entries().next().value!;
      timers.delete(id);
      entry.use();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("pending recording updates without another step; hidden/private scope stops reads", async () => {
  const reads: string[] = [];
  const f = fixture(async (id) => {
    reads.push(id);
  });
  f.observer.update("original-review");
  assert.equal([...f.timers.values()][0].delay, 3000);
  await f.fire();
  assert.deepEqual(reads, ["original-review"]);
  f.visible(false);
  f.observer.visibilityChanged();
  assert.equal(f.timers.size, 0);
  assert.equal(f.rested(), 0);
  f.visible(true);
  f.observer.visibilityChanged();
  assert.equal([...f.timers.values()][0].delay, 0);
  await f.fire();
  assert.deepEqual(reads, ["original-review", "original-review"]);
  f.current(false);
  await f.fire();
  assert.equal(reads.length, 2);
  assert.equal(f.timers.size, 0);
  f.observer.dispose();
});

test("observation is bounded and late reads cannot reopen a completed or replaced review", async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
  });
  f.observer.update("original-review");
  for (let i = 0; i < 90; i++) await f.fire();
  assert.equal(reads, 90);
  assert.equal(f.timers.size, 0);
  assert.equal(f.rested(), 1);
  f.observer.visibilityChanged();
  await f.fire();
  assert.equal(reads, 91);
  f.observer.update(null);
  assert.equal(f.timers.size, 0);

  let finish!: () => void;
  const pending = fixture(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  pending.observer.update("old-review");
  await pending.fire();
  pending.observer.update("new-review");
  assert.equal(pending.timers.size, 1);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(pending.timers.size, 1);
  pending.observer.dispose();
  assert.equal(pending.timers.size, 0);
});

test("latest and orphan evidence continue observation; safe confirmation or private denial stops it", async () => {
  const f = danceFixture();
  const prepared = await f.prepare();
  await f.service.decide(
    "owner",
    "observe-decision",
    prepared.reviewId,
    1,
    "pass",
    f.ports.reviewerConsent.version,
  );
  const review = await f.store.review(prepared.reviewId);
  assert.equal(danceNeedsObservation(review), true);
  // Explicit memory-model evidence; this does not establish actual chain proof.
  review.canonical = f.canonical(review.decision!, String(f.store.time / 1000));
  review.state = "canonical";
  review.canonical.finality = "latest";
  assert.equal(danceNeedsObservation(review), true);
  review.canonical.finality = "safe";
  assert.equal(danceNeedsObservation(review), false);
  review.canonical.canonical = false;
  assert.equal(danceNeedsObservation(review), true);
  review.localDenied = true;
  assert.equal(danceNeedsObservation(review), false);
});
