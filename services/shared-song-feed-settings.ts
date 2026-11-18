import { exact, insist, object } from "../packages/community/common.ts";
import { httpsOrigin } from "../packages/community/manifest-core.ts";
import { recognitionProfile } from "../packages/recognition/intent.ts";

export const sharedSongFeedBinding = "COMMUNITY_SHARED_SONG_FEED_JSON";

export function parseSharedSongFeed(raw: string) {
  insist(raw.length <= 8192, "invalid_shared_song_feed_profile", 503);
  const input = object(JSON.parse(raw));
  exact(input, ["schema", "proofOrigins", "recognition"]);
  insist(input.schema === "pirate.shared-song-feed-profile/1" &&
    Array.isArray(input.proofOrigins) && input.proofOrigins.length <= 16,
    "invalid_shared_song_feed_profile", 503);
  const origins = new Set(input.proofOrigins.map(httpsOrigin));
  const recognition = input.recognition === null ? null : recognitionProfile(input.recognition);
  insist(origins.size === input.proofOrigins.length && (recognition || origins.size === 0),
    "invalid_shared_song_feed_profile", 503);
  return { origins, recognition };
}
