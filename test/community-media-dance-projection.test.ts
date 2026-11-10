import test from "node:test";
import assert from "node:assert/strict";
import {
  projectDanceMedia,
  projectDanceSubmission,
} from "../packages/community-media/dance-projection.ts";
import type {
  MediaReviewWitness,
  MediaSubmissionReceipt,
  ReadyMedia,
} from "../packages/community-media/contracts.ts";
import { PRIVATE_RETENTION_MS } from "../packages/community-media/validation.ts";

const submitted = 1_800_086_400_123,
  deadline = submitted + PRIVATE_RETENTION_MS;
function facts() {
  const media: ReadyMedia = {
    version: "pirate.community-media/1",
    id: "private-media",
    communityId: "community",
    accountId: "learner",
    songKey: "song",
    songRevision: 3,
    audioSha256: "a".repeat(64),
    recordingSha256: "b".repeat(64),
    startSample: 0,
    durationSamples: 6 * 48000,
    mediaPolicyVersion: "pirate.dance-private/1",
    revision: 7,
    purpose: "private-review",
    readyAt: 1_800_000_000_123,
    expiresAt: deadline,
    rendition: {
      sha256: "c".repeat(64),
      bytes: 100,
      durationMs: 6000,
      width: 320,
      height: 240,
      videoCodec: "h264",
      audioCodec: "aac",
    },
  };
  const witness: MediaReviewWitness = {
    id: media.id,
    communityId: media.communityId,
    accountId: media.accountId,
    revision: media.revision,
    recordingSha256: media.recordingSha256,
    expiresAt: media.expiresAt,
  };
  const receipt: MediaSubmissionReceipt = {
    submissionId: "submission",
    communityId: media.communityId,
    accountId: media.accountId,
    mediaId: media.id,
    bindingCommitment: "d".repeat(64),
    trustedSubmittedAtMs: submitted,
    reviewDeadlineMs: deadline,
    mediaRevision: media.revision,
  };
  return { media, witness, receipt };
}

test("Dance readiness timestamps preserve exact milliseconds and do not become submission time or access", () => {
  const { media, witness } = facts(),
    projected = projectDanceMedia(media, witness);
  assert.equal(projected.readyAtMs, 1_800_000_000_123);
  assert.equal(projected.expiresAtMs, deadline);
  for (const key of [
    "uploadedAtMs",
    "trustedSubmittedAtMs",
    "reviewDeadlineMs",
    "playbackUrl",
    "sourceKey",
    "renditionKey",
  ])
    assert.equal(key in projected, false);
  assert.throws(
    () => projectDanceMedia(media, { ...witness, revision: 6 }),
    /media_dance_witness_mismatch/,
  );
  assert.throws(
    () => projectDanceMedia({ ...media, purpose: "public-feed" }, witness),
    /media_dance_profile_mismatch/,
  );
  assert.throws(
    () => projectDanceMedia({ ...media, durationSamples: 3 * 48000 }, witness),
    /media_dance_profile_mismatch/,
  );
});

test("seven-day review projection requires the actual accepted receipt and post-retention revision", () => {
  const { media, witness, receipt } = facts(),
    projected = projectDanceMedia(media, witness);
  const submission = projectDanceSubmission(projected, receipt);
  assert.equal(submission.trustedSubmittedAtMs, submitted);
  assert.equal(
    submission.reviewDeadlineMs - submission.trustedSubmittedAtMs,
    604800000,
  );
  assert.notEqual(submission.trustedSubmittedAtMs, projected.readyAtMs);
  assert.throws(
    () =>
      projectDanceSubmission(projected, {
        ...receipt,
        trustedSubmittedAtMs: media.readyAt,
      }),
    /media_dance_submission_mismatch/,
  );
  assert.throws(
    () => projectDanceSubmission(projected, { ...receipt, mediaRevision: 6 }),
    /media_dance_submission_mismatch/,
  );
  assert.throws(
    () =>
      projectDanceSubmission(
        { ...projected, expiresAtMs: deadline - 1 },
        receipt,
      ),
    /media_dance_submission_mismatch/,
  );
});
