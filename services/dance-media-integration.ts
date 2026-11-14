import { bytes32, CommunityError } from "../packages/community/common.ts";
import type {
  DanceMediaBinding,
  DanceMediaPort,
  DanceMediaWitness,
  DanceReadyMedia,
} from "../packages/dance/contracts.ts";
import {
  projectDanceMedia,
  projectDanceSubmission,
} from "../packages/community-media/dance-projection.ts";
import {
  MEDIA_COMMIT_GUARD,
  mediaCommitValues,
} from "../packages/community-media/repository.ts";
import {
  MEDIA_SUBMISSION_DB_NOW,
  prepareMediaSubmission,
} from "../packages/community-media/submission.ts";
import { digest, MediaError } from "../packages/community-media/validation.ts";
import type {
  MediaRecord,
  MediaActor,
} from "../packages/community-media/contracts.ts";
import type { DanceReviewService } from "./dance-review.ts";
import type { CommunityMedia } from "./community-media.ts";
import type { DanceSource3Bindings } from "./dance-source3-bindings.ts";
import {
  createDanceMediaPort,
  DANCE_MEDIA_PRODUCER_PIN,
} from "./dance-media.ts";

function producerBinding(binding: DanceMediaBinding) {
  return {
    ...binding,
    audioSha256: bytes32(binding.audioSha256).slice(2),
    recordingSha256: bytes32(binding.recordingSha256).slice(2),
  };
}
function producerWitness(witness: DanceMediaWitness) {
  return {
    ...witness,
    recordingSha256: bytes32(witness.recordingSha256).slice(2),
  };
}
function captureDigests<
  T extends { audioSha256: string; recordingSha256: string },
>(facts: T): T {
  return {
    ...facts,
    audioSha256: bytes32(`0x${digest(facts.audioSha256)}`),
    recordingSha256: bytes32(`0x${digest(facts.recordingSha256)}`),
  };
}
function ready(result: Awaited<ReturnType<CommunityMedia["readyForReview"]>>) {
  const { media, witness } = result;
  return {
    media: captureDigests(media),
    witness: {
      ...witness,
      recordingSha256: bytes32(`0x${digest(witness.recordingSha256)}`),
    },
  };
}
async function danceRead(
  read: () => ReturnType<CommunityMedia["readyForReview"]>,
) {
  try {
    return ready(await read());
  } catch (error) {
    // The Dance queue skips expected item denials and preserves infrastructure
    // errors. The two lanes keep distinct public error types at their ports.
    if (
      error instanceof MediaError &&
      [401, 403, 404, 409, 410].includes(error.status)
    )
      throw new CommunityError(error.code, error.status);
    throw error;
  }
}
function producerMedia(media: DanceReadyMedia) {
  return { ...media, ...producerBinding(media) };
}

/** Producer and consumer share the same repository and D1 batch. The ready
 * accessors keep their separate uploader and non-self reviewer checks. */
export function integratedDanceMedia(service: CommunityMedia, source3?: DanceSource3Bindings): DanceMediaPort {
  return createDanceMediaPort(
    {
      async readyForSubmission(id, binding, actor) {
        binding = structuredClone(binding); actor = structuredClone(actor);
        if (source3) await source3.assertUploaderMedia(id, actor, binding.recordingSha256);
        return danceRead(() =>
          service.readyForSubmission(id, producerBinding(binding), actor),
        );
      },
      async readyForReview(id, binding, actor) {
        binding = structuredClone(binding); actor = structuredClone(actor);
        return danceRead(() =>
          service.readyForReview(id, producerBinding(binding), actor),
        );
      },
      prepareMediaSubmission(witness, submissionId, commitment, accepted) {
        return prepareMediaSubmission(
          service.ports.repository,
          producerWitness(witness),
          submissionId,
          bytes32(commitment),
          accepted,
        );
      },
      commitFence(witness) {
        const [id, community, account, revision, , recording] =
          mediaCommitValues(producerWitness(witness), 0);
        return {
          sql: MEDIA_COMMIT_GUARD.replace(
            "expires_at>?",
            `expires_at>${MEDIA_SUBMISSION_DB_NOW} AND expires_at=?`,
          ),
          values: [
            id,
            community,
            account,
            revision,
            witness.expiresAt,
            recording,
          ],
        };
      },
      projectDanceMedia(media, witness) {
        return captureDigests(
          projectDanceMedia(producerMedia(media), producerWitness(witness)),
        );
      },
      projectDanceSubmission(media, receipt) {
        return projectDanceSubmission(
          { ...media, ...producerBinding(media) },
          { ...receipt, bindingCommitment: bytes32(receipt.bindingCommitment) },
        );
      },
    },
    DANCE_MEDIA_PRODUCER_PIN,
  );
}

/** Both the uploader and delegated reviewer use the live Dance authority for
 * a submitted recording. A pre-submission preview requires a separate exact
 * capture witness from the reservation mount. */
export function dancePrivatePlaybackAuthority(
  dance: Pick<DanceReviewService, "inspect">,
  pending?: (actor: MediaActor, media: MediaRecord) => Promise<boolean>,
) {
  return async (actor: MediaActor, media: MediaRecord) => {
    if (!media.submissionId)
      return (
        actor.accountId === media.accountId && !!(await pending?.(actor, media))
      );
    try {
      const allowed = await dance.inspect(actor.accountId, media.submissionId);
      return (
        allowed.reviewId === media.submissionId && allowed.mediaId === media.id
      );
    } catch (error) {
      if (
        error instanceof CommunityError &&
        [401, 403, 404, 409, 410].includes(error.status)
      )
        return false;
      throw error;
    }
  };
}
