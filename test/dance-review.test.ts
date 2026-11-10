import test from "node:test";
import assert from "node:assert/strict";
import { danceFixture } from "./dance-fixture.ts";
import { REVIEW_WINDOW_MS } from "../packages/dance/contracts.ts";
import {
  decisionIntegrityHash,
  decisionEvidencePreimage,
} from "../packages/dance/intent.ts";
test("D1 decision MODEL remains pending; only separate canonical evidence establishes verdict time", async () => {
  const f = danceFixture(),
    r = await f.prepare();
  const receipt = await f.service.decide(
    "owner",
    "decision",
    r.reviewId,
    1,
    "pass",
    f.ports.reviewerConsent.version,
  );
  assert.equal(receipt?.state, "decision_pending");
  let review = await f.service.get("learner", r.reviewId);
  assert.equal(review.canonical, null);
  assert.equal(review.decision?.preimage.verdict, "pass");
  assert.equal((await f.store.outbox("decision")).status, "held");
  assert.equal(
    review.decision!.localIntegrityHash,
    decisionIntegrityHash(review.decision!.preimage),
  );
  assert.equal(
    (await f.store.outbox("decision")).payloadJson,
    decisionEvidencePreimage(review.decision!.preimage),
  );
  const committed = f.canonical(
    review.decision!,
    String(f.store.time / 1000 + 9),
  );
  f.evidence.set("decision", committed);
  review = await f.service.reconcile(r.reviewId);
  assert.equal(
    review.canonical?.committedAtSeconds,
    committed.committedAtSeconds,
  );
  assert.equal(review.state, "canonical");
  assert.equal(review.decision!.preimage.intentAcceptedAtMs, f.store.time);
});
test("actual accepted submission + seven days exclusive; upload/reservation never starts review", async () => {
  const f = danceFixture(),
    r = await f.prepare({ delayMs: 86400000 });
  const review = await f.service.get("learner", r.reviewId);
  assert.equal(
    review.receipt.trustedSubmittedAtMs,
    r.capture.reservedAtMs + 86400000,
  );
  assert.equal(
    review.receipt.reviewDeadlineMs,
    review.receipt.trustedSubmittedAtMs + REVIEW_WINDOW_MS,
  );
  assert.equal(review.receipt.mediaRevision, 2);
  f.store.time = review.receipt.reviewDeadlineMs - 1;
  assert.equal(
    (await f.service.get("learner", r.reviewId)).state,
    "awaiting_review",
  );
  f.store.time++;
  assert.equal((await f.service.get("learner", r.reviewId)).state, "expired");
  await assert.rejects(
    f.service.decide(
      "owner",
      "late",
      r.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    ),
    /dance_review_expired/,
  );
  await assert.rejects(
    f.service.inspect("owner", r.reviewId),
    /dance_media_unavailable/,
  );
});
test("opposite/racing decisions produce one immutable intent; original uncertain response recovers", async () => {
  const f = danceFixture(),
    r = await f.prepare();
  f.store.loseResponse = true;
  const receipt = await f.service.decide(
    "owner",
    "original",
    r.reviewId,
    1,
    "pass",
    f.ports.reviewerConsent.version,
  );
  assert.equal(receipt?.intentId, "original");
  f.store.time += 5000;
  assert.deepEqual(
    await f.service.decide(
      "owner",
      "original",
      r.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    ),
    receipt,
  );
  await assert.rejects(
    f.service.decide(
      "owner",
      "opposite",
      r.reviewId,
      1,
      "not_passed",
      f.ports.reviewerConsent.version,
    ),
    /dance_decision_already_pending/,
  );
  await assert.rejects(
    f.service.decide(
      "owner",
      "original",
      r.reviewId,
      1,
      "not_passed",
      f.ports.reviewerConsent.version,
    ),
    /dance_idempotency_conflict/,
  );
  const b = await f.prepare();
  const outcomes = await Promise.allSettled([
    f.service.decide(
      "owner",
      "a",
      b.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    ),
    f.service.decide(
      "owner",
      "b",
      b.reviewId,
      1,
      "not_passed",
      f.ports.reviewerConsent.version,
    ),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
});
test("local withdrawal stops access/unsent dispatch but cannot replace a published decision", async () => {
  const f = danceFixture(),
    r = await f.prepare();
  await f.service.decide(
    "owner",
    "chosen",
    r.reviewId,
    1,
    "pass",
    f.ports.reviewerConsent.version,
  );
  const pending = await f.service.get("learner", r.reviewId);
  await f.service.end(
    "learner",
    "withdraw",
    r.reviewId,
    pending.revision,
    "withdraw",
  );
  await assert.rejects(
    f.service.inspect("owner", r.reviewId),
    /dance_media_unavailable/,
  );
  assert.equal((await f.store.outbox("chosen")).status, "canceled");
  f.evidence.set("chosen", f.canonical(pending.decision!));
  const accepted = await f.service.reconcile(r.reviewId);
  assert.equal(accepted.canonical?.verdict, "pass");
  assert.ok(accepted.localDenied);
  const orphan = { ...accepted.canonical!, canonical: false };
  f.evidence.set("chosen", orphan);
  const demoted = await f.service.reconcile(r.reviewId);
  assert.equal(demoted.state, "withdrawal_pending");
  assert.equal(demoted.decision!.commandId, "chosen");
  await assert.rejects(
    f.service.decide(
      "owner",
      "replacement",
      r.reviewId,
      demoted.revision,
      "not_passed",
      f.ports.reviewerConsent.version,
    ),
    /dance_decision_already_pending/,
  );
});
test("exact recording reuse and consent admission are fenced", async () => {
  const f = danceFixture(),
    r = await f.prepare();
  await assert.rejects(
    f.prepare({ digest: r.recordingSha256 }),
    /dance_recording_reused/,
  );
  f.holdTerms();
  await assert.rejects(
    f.service.capture(
      "learner",
      "held",
      { songKey: r.capture.songKey, offerId: null, referenceId: null },
      f.consent,
    ),
    /dance_terms_admission_held/,
  );
});
