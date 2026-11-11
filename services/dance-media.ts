import { insist } from "../packages/community/common.ts";
import type { DanceMediaPort } from "../packages/dance/contracts.ts";
export const DANCE_MEDIA_PRODUCER_PIN = Object.freeze({
  commit: "7949d9cf80a63c7e3a4e2c4220c1c1fb2b171ac7",
  projectionSha256:
    "10ec6556355d9e575f4b38d9080134f4157d692bb552335da3e409c144366d58",
  submissionSha256:
    "a3d87ca61a69f18f6fa9ede256a325e9fc42847e3b1f6b16cfef4b59c273658e",
});
/** Inject the actual stable producer accessors/projectors and repository-bound
 * prepareMediaSubmission. No second media pipeline or mutable peer import.
 * Root must run Dance.inspect for EVERY private GET/HEAD/range, uploader too.
 */
export function createDanceMediaPort(
  producer: Omit<DanceMediaPort, "version">,
  pin: typeof DANCE_MEDIA_PRODUCER_PIN,
): DanceMediaPort {
  insist(
    pin.commit === DANCE_MEDIA_PRODUCER_PIN.commit &&
      pin.projectionSha256 === DANCE_MEDIA_PRODUCER_PIN.projectionSha256 &&
      pin.submissionSha256 === DANCE_MEDIA_PRODUCER_PIN.submissionSha256,
    "dance_media_producer_integration_held",
    503,
  );
  return { ...producer, version: "pirate.dance-media-port/1" };
}
