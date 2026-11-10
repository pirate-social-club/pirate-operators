import type {
  MediaBinding,
  MediaReviewWitness,
  MediaSubmissionReceipt,
  ReadyMedia,
} from "./contracts.ts";
import { integer, PRIVATE_RETENTION_MS, requireMedia } from "./validation.ts";

export const MEDIA_DANCE_PROJECTION = "pirate.community-media-dance/1" as const;
/** Server-owned facts only. This is neither playback access nor canonical
 * verdict authority. Obtain it from the appropriate fresh media accessor. */
export interface DanceMediaFacts extends MediaBinding {
  version: typeof MEDIA_DANCE_PROJECTION;
  id: string;
  revision: number;
  purpose: "private-review";
  readyAtMs: number;
  expiresAtMs: number;
}

export function projectDanceMedia(
  media: ReadyMedia,
  witness: MediaReviewWitness,
): DanceMediaFacts {
  integer(media.readyAt, 0, Number.MAX_SAFE_INTEGER);
  integer(media.expiresAt, media.readyAt + 1, Number.MAX_SAFE_INTEGER);
  integer(media.revision, 1, Number.MAX_SAFE_INTEGER);
  requireMedia(
    media.purpose === "private-review" &&
      media.durationSamples >= 6 * 48000 &&
      media.durationSamples <= 30 * 48000,
    "media_dance_profile_mismatch",
    409,
  );
  requireMedia(
    media.id === witness.id &&
      media.communityId === witness.communityId &&
      media.accountId === witness.accountId &&
      media.revision === witness.revision &&
      media.recordingSha256 === witness.recordingSha256 &&
      media.expiresAt === witness.expiresAt,
    "media_dance_witness_mismatch",
    409,
  );
  const {
    communityId,
    accountId,
    songKey,
    songRevision,
    audioSha256,
    recordingSha256,
    startSample,
    durationSamples,
    mediaPolicyVersion,
    id,
    revision,
  } = media;
  return {
    version: MEDIA_DANCE_PROJECTION,
    communityId,
    accountId,
    songKey,
    songRevision,
    audioSha256,
    recordingSha256,
    startSample,
    durationSamples,
    mediaPolicyVersion,
    id,
    revision,
    purpose: "private-review",
    readyAtMs: media.readyAt,
    expiresAtMs: media.expiresAt,
  };
}

/** Submission timing comes exclusively from the accepted atomic receipt.
 * Never derive it from readyAtMs, reservation, upload or retry time. */
export function projectDanceSubmission(
  media: DanceMediaFacts,
  receipt: MediaSubmissionReceipt,
) {
  integer(
    receipt.trustedSubmittedAtMs,
    0,
    Number.MAX_SAFE_INTEGER - PRIVATE_RETENTION_MS,
  );
  requireMedia(
    receipt.communityId === media.communityId &&
      receipt.accountId === media.accountId &&
      receipt.mediaId === media.id &&
      receipt.mediaRevision === media.revision &&
      receipt.reviewDeadlineMs ===
        receipt.trustedSubmittedAtMs + PRIVATE_RETENTION_MS &&
      media.expiresAtMs === receipt.reviewDeadlineMs,
    "media_dance_submission_mismatch",
    409,
  );
  return {
    submissionId: receipt.submissionId,
    bindingCommitment: receipt.bindingCommitment,
    trustedSubmittedAtMs: receipt.trustedSubmittedAtMs,
    reviewDeadlineMs: receipt.reviewDeadlineMs,
  };
}
