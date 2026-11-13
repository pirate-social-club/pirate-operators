import { prepareBufferedGuide } from "./platform/buffered-guide.ts";
import { danceRecordingDigest } from "./dance-recording.ts";
import type { DanceCapture } from "../../../../../packages/dance/contracts.ts";
import type { DancePlaybackPort } from "./ports.ts";
import { producerDigest } from "./digests.ts";
export type DanceSongGuideGrant = import("../../../../../packages/dance/production.ts").DanceGuideGrant;
/** Reuses actual c7 complete buffering; the producer supplies fresh canonical
 * listening access, not a central API, cached URL or selected provider. */
export function createDancePlaybackPort(input: {
  readonly songGrant: (
    capture: DanceCapture,
    signal: AbortSignal,
  ) => Promise<DanceSongGuideGrant>;
  readonly reference: DancePlaybackPort["reference"];
  readonly fetcher?: typeof fetch;
  readonly isCurrent?: () => boolean;
}): DancePlaybackPort {
  return {
    reference: input.reference,
    guide: async (capture, signal) => {
      signal.throwIfAborted();
      if (input.isCurrent && !input.isCurrent()) throw Error("dance_session_changed");
      const source = await prepareBufferedGuide(capture.songKey, signal, {
        readGrant: async (_key, pending) => {
          const grant = await input.songGrant(capture, pending);
          pending.throwIfAborted();
          if (
            grant.communityId !== capture.communityId ||
            grant.songKey !== capture.songKey ||
            grant.songRevision !== capture.songRevision ||
            grant.audioSha256 !== capture.audioSha256 ||
            (grant.access === "public" ? grant.expires_at !== undefined :
              (!Number.isSafeInteger(grant.expires_at) ||
                grant.expires_at > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ||
                grant.expires_at * 1000 <= Date.now()))
          )
            throw Error("dance_guide_target_changed");
          return grant;
        },
        fetch: input.fetcher,
      });
      try {
        const digest = await danceRecordingDigest(source.blob);
        signal.throwIfAborted();
        if ((input.isCurrent && !input.isCurrent()) ||
          (source.expiresAtSeconds !== undefined && source.expiresAtSeconds * 1000 <= Date.now()) ||
          digest !== producerDigest(capture.audioSha256))
          throw Error("dance_guide_target_changed");
        return source;
      } catch (error) {
        source.release();
        throw error;
      }
    },
  };
}
