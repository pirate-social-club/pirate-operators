import type { CommunityMedia } from "./community-media.ts";
import type {
  MediaActor,
  MediaBinding,
  MediaReviewWitness,
  ReadyMedia,
} from "../packages/community-media/contracts.ts";
import {
  readyFacts,
  requireMedia,
  sameBinding,
} from "../packages/community-media/validation.ts";

export async function readyForMediaReview(
  service: CommunityMedia,
  id: string,
  binding: MediaBinding,
  reviewer: MediaActor,
): Promise<{ media: ReadyMedia; witness: MediaReviewWitness }> {
  await service.actor(reviewer);
  const record = await service.ports.repository.get(id);
  await service.usable(record);
  requireMedia(
    record.purpose === "private-review" &&
      record.accountId !== reviewer.accountId &&
      (await service.ports.reviewAuthority(reviewer, record)),
    "media_review_forbidden",
    403,
  );
  requireMedia(sameBinding(record, binding), "media_binding_mismatch", 409);
  const media = readyFacts(record);
  const { communityId, accountId, revision, recordingSha256, expiresAt } =
    record;
  return {
    media,
    witness: {
      id,
      communityId,
      accountId,
      revision,
      recordingSha256,
      expiresAt,
    },
  };
}

/** Uploader access; actual trusted submission owns retention. */
export async function readyForMediaSubmission(
  service: CommunityMedia,
  id: string,
  binding: MediaBinding,
  uploader: MediaActor,
): Promise<{ media: ReadyMedia; witness: MediaReviewWitness }> {
  const record = await service.owned(id, uploader);
  await service.usable(record);
  requireMedia(
    record.purpose === "private-review",
    "media_submission_forbidden",
    403,
  );
  requireMedia(sameBinding(record, binding), "media_binding_mismatch", 409);
  requireMedia(
    service.privateCapability().allowed &&
      record.mediaPolicyVersion ===
        service.ports.privateReviewPolicy!.version &&
      record.durationSamples >= 6 * 48000 &&
      record.durationSamples <= 30 * 48000,
    "media_private_policy_changed",
    409,
  );
  const media = readyFacts(record);
  const { communityId, accountId, revision, recordingSha256, expiresAt } =
    record;
  return {
    media,
    witness: {
      id,
      communityId,
      accountId,
      revision,
      recordingSha256,
      expiresAt,
    },
  };
}
