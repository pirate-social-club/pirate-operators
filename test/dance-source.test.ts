import test from "node:test";
import assert from "node:assert/strict";
import { danceFixture } from "./dance-fixture.ts";
import {
  canonicalMilliseconds,
  cutoffIsSafe,
  danceQualificationEntries,
} from "../packages/dance/categorical-source.ts";
test("canonical seconds are validated and converted once; safe head must reach exact cutoff", () => {
  assert.equal(canonicalMilliseconds("1800000000"), 1800000000000);
  for (const v of ["1.2", "-1", "01", "9007199254741"])
    assert.throws(() => canonicalMilliseconds(v), /dance_canonical_time/);
  assert.equal(cutoffIsSafe("1000", 1000001), false);
  assert.equal(cutoffIsSafe("1001", 1000001), true);
});
test("canonical [opening,cutoff) milliseconds, no-offer/out-of-window pass and latest/orphan handling", async () => {
  const f = danceFixture(),
    r = await f.prepare();
  await f.service.decide(
    "owner",
    "canonical",
    r.reviewId,
    1,
    "pass",
    f.ports.reviewerConsent.version,
  );
  const review = await f.store.review(r.reviewId),
    base = f.store.time;
  const offer = {
    ...review.capture.offer!,
    opensAtMs: base + 1000,
    cutoffAtMs: base + 2001,
  };
  review.capture.offer = offer;
  review.decision!.preimage.capture = structuredClone(review.capture);
  // Explicit model canonical adapter, not actual ABI/chain acceptance.
  const { decisionIntegrityHash } = await import("../packages/dance/intent.ts");
  review.decision!.localIntegrityHash = decisionIntegrityHash(
    review.decision!.preimage,
  );
  const event = (ms: number) =>
    f.canonical(review.decision!, String(ms / 1000));
  const context = {
    ...offer,
    songKey: review.capture.songKey,
    sourceAdmitted: true,
    safeHeadTimestampSeconds: String((base + 3000) / 1000),
  };
  assert.equal(
    danceQualificationEntries([{ review, evidence: event(base) }], context)
      .length,
    0,
  );
  assert.equal(
    danceQualificationEntries(
      [{ review, evidence: event(base + 1000) }],
      context,
    ).length,
    1,
  );
  assert.equal(
    danceQualificationEntries(
      [{ review, evidence: event(base + 2000) }],
      context,
    ).length,
    1,
  );
  assert.equal(
    danceQualificationEntries(
      [{ review, evidence: event(base + 3000) }],
      context,
    ).length,
    0,
  );
  assert.throws(
    () =>
      danceQualificationEntries([{ review, evidence: event(base + 1000) }], {
        ...context,
        safeHeadTimestampSeconds: String((base + 2000) / 1000),
      }),
    /reward_cutoff_not_confirmed/,
  );
  assert.equal(
    danceQualificationEntries(
      [{ review, evidence: { ...event(base + 1000), finality: "latest" } }],
      context,
    ).length,
    0,
  );
  assert.equal(
    danceQualificationEntries(
      [{ review, evidence: { ...event(base + 1000), canonical: false } }],
      context,
    ).length,
    0,
  );
  assert.throws(
    () =>
      danceQualificationEntries([{ review, evidence: event(base + 1000) }], {
        ...context,
        sourceAdmitted: false,
      }),
    /dance_source_admission_held/,
  );
  f.principals.learner.active = false;
  assert.equal(
    danceQualificationEntries(
      [{ review, evidence: event(base + 1000) }],
      context,
    ).length,
    1,
  );
});
