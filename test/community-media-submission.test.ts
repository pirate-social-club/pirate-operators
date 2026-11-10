import test from "node:test";
import assert from "node:assert/strict";
import { fixture, actor, reviewer } from "./community-media-fixture.ts";
import {
  prepareMediaSubmission,
  mediaSubmissionReceipt,
} from "../packages/community-media/submission.ts";
import { PRIVATE_RETENTION_MS } from "../packages/community-media/validation.ts";
import type { MediaSubmissionWitness } from "../packages/community-media/contracts.ts";

const commitment = "e".repeat(64),
  submissionId = "dance_submission_1";
async function submissionFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  await f.db
    .prepare(
      `CREATE TABLE dance_accepted_fixture(
    community TEXT,submission TEXT,media TEXT,binding TEXT,submitted INTEGER,deadline INTEGER,revision INTEGER,
    PRIMARY KEY(community,submission))`,
    )
    .run();
  f.setNow(Date.now() - 86_400_000);
  const record = await f.ready();
  f.setNow(Date.now());
  const { witness } = await f.service.readyForSubmission(
    record.id,
    record,
    actor,
  );
  const plan = (w = witness, sid = submissionId, hash = commitment) =>
    prepareMediaSubmission(f.repository, w, sid, hash, {
      sql: `EXISTS(SELECT 1 FROM dance_accepted_fixture d JOIN community_media_submissions s
      ON d.community=s.community_id AND d.submission=s.submission_id
      WHERE d.community=? AND d.submission=? AND d.media=s.media_id AND d.binding=s.binding_commitment
      AND d.submitted=s.submitted_at_ms AND d.deadline=s.deadline_ms AND d.revision=s.media_revision)`,
      values: [f.song.communityId, sid],
    });
  const accept = (sid = submissionId) =>
    f.db
      .prepare(
        `INSERT INTO dance_accepted_fixture
    SELECT community_id,submission_id,media_id,binding_commitment,submitted_at_ms,deadline_ms,media_revision
    FROM community_media_submissions WHERE community_id=? AND submission_id=? ON CONFLICT DO NOTHING`,
      )
      .bind(f.song.communityId, sid);
  const commit = async (
    w: MediaSubmissionWitness = witness,
    sid = submissionId,
    hash = commitment,
  ) => {
    const p = plan(w, sid, hash);
    await f.db.batch([
      ...p.beforeAcceptance,
      accept(sid),
      ...p.afterAcceptance,
    ]);
    return mediaSubmissionReceipt(f.repository, sid);
  };
  return { ...f, record, witness, plan, accept, commit };
}

test("uploader submission access is separate from reviewer and checks exact current media", async (t) => {
  const f = await submissionFixture(t);
  await assert.rejects(
    f.service.readyForReview(f.record.id, f.record, actor),
    /media_review_forbidden/,
  );
  await assert.rejects(
    f.service.readyForSubmission(f.record.id, f.record, reviewer),
    /media_not_found/,
  );
  await assert.rejects(
    f.service.readyForSubmission(
      f.record.id,
      { ...f.record, recordingSha256: "f".repeat(64) },
      actor,
    ),
    /media_binding_mismatch/,
  );
  const policy = f.ports.privateReviewPolicy!;
  f.ports.privateReviewPolicy = {
    ...policy,
    version: "pirate.dance-private/2",
  };
  await assert.rejects(
    f.service.readyForSubmission(f.record.id, f.record, actor),
    /media_private_policy_changed/,
  );
  f.ports.privateReviewPolicy = policy;
  f.changeSong();
  await assert.rejects(
    f.service.readyForSubmission(f.record.id, f.record, actor),
    /media_song_revision_changed/,
  );
});

test("accepted submission anchors full seven days at trusted commit, with exact replay and exclusive expiry", async (t) => {
  const f = await submissionFixture(t),
    receipt = await f.commit();
  assert.ok(receipt.trustedSubmittedAtMs > f.record.createdAt + 86_000_000);
  assert.equal(
    receipt.reviewDeadlineMs,
    receipt.trustedSubmittedAtMs + PRIVATE_RETENTION_MS,
  );
  const retained = await f.repository.get(f.record.id);
  assert.equal(retained.expiresAt, receipt.reviewDeadlineMs);
  assert.equal(retained.trustedSubmittedAtMs, receipt.trustedSubmittedAtMs);
  assert.deepEqual(await f.commit(), receipt); // Same old witness and receipt, no extension.
  await assert.rejects(
    f.commit(f.witness, "different_submission"),
    /CHECK constraint failed/,
  );
  await assert.rejects(
    f.commit(f.witness, submissionId, "f".repeat(64)),
    /CHECK constraint failed/,
  );
  f.setNow(receipt.reviewDeadlineMs - 1);
  assert.equal(
    (await f.http(`/api/media/${retained.id}/playback`, actor))?.status,
    200,
  );
  await f.service.recover();
  assert.equal((await f.repository.get(retained.id)).state, "ready");
  f.setNow(receipt.reviewDeadlineMs);
  assert.equal(
    (await f.http(`/api/media/${retained.id}/playback`, actor))?.status,
    410,
  );
  await f.service.recover();
  assert.equal((await f.repository.get(retained.id)).state, "expired");
});

test("retention rolls back without actual accepted Dance receipt or on acceptance failure", async (t) => {
  const f = await submissionFixture(t),
    p = f.plan();
  await assert.rejects(
    f.db.batch([...p.beforeAcceptance, ...p.afterAcceptance]),
    /CHECK constraint failed/,
  );
  await assert.rejects(
    mediaSubmissionReceipt(f.repository, submissionId),
    /media_submission_not_found/,
  );
  assert.equal(
    (await f.repository.get(f.record.id)).expiresAt,
    f.record.expiresAt,
  );
  await assert.rejects(
    f.db.batch([
      ...p.beforeAcceptance,
      f.db.prepare("INSERT INTO missing_dance_fixture VALUES(1)"),
      ...p.afterAcceptance,
    ]),
  );
  await assert.rejects(
    mediaSubmissionReceipt(f.repository, submissionId),
    /media_submission_not_found/,
  );
  assert.equal(
    (await f.repository.get(f.record.id)).revision,
    f.record.revision,
  );
});

test("withdrawal or unsubmitted expiry wins against stale submission retention plan", async (t) => {
  const f = await submissionFixture(t);
  await f.service.withdraw(f.record.id, actor);
  await assert.rejects(f.commit(), /CHECK constraint failed/);
  assert.equal((await f.repository.get(f.record.id)).state, "withdrawn");
  const unsubmitted = await f.ready({ requestId: "unsubmitted_0002" });
  f.setNow(unsubmitted.expiresAt);
  await assert.rejects(
    f.service.readyForSubmission(unsubmitted.id, unsubmitted, actor),
    /media_unavailable/,
  );
  await f.service.recover();
  assert.equal((await f.repository.get(unsubmitted.id)).state, "expired");
});

test("lost submission response reconciles original receipt without retargeting or extending retention", async (t) => {
  const f = await submissionFixture(t);
  await assert.rejects(
    (async () => {
      await f.commit();
      throw Error("lost response");
    })(),
    /lost response/,
  );
  const committed = await mediaSubmissionReceipt(f.repository, submissionId);
  assert.deepEqual(await f.commit(), committed);
  assert.equal(
    (await f.repository.get(f.record.id)).expiresAt,
    committed.reviewDeadlineMs,
  );
});

test("private Dance policy must be explicitly injected; public clips keep their own bounds", async (t) => {
  const f = await fixture(t);
  f.ports.privateReviewPolicy = undefined;
  await assert.rejects(f.reserve(), /media_private_policy_unconfigured/);
  f.allowPublic();
  assert.equal(
    (
      await f.reserve({
        purpose: "public-feed",
        publicConsent: true,
        durationSamples: 3 * 48000,
      })
    ).state,
    "uploading",
  );
  await assert.rejects(
    f.reserve({
      requestId: "public_long_0002",
      purpose: "public-feed",
      publicConsent: true,
      durationSamples: 30 * 48000,
    }),
    /invalid_media_integer/,
  );
});
