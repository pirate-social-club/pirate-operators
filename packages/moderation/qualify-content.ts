import { moderateText, classifyLyrics } from "./openai.ts";
import { defaultContentProfile } from "./content-profile.ts";
import type { ProviderTransport } from "./provider-http.ts";
import { insist } from "../community/common.ts";
/** Two calls through the actual runtime request and parser. The caller must
 * persist intent before entry and must not retry an unknown response. */
export async function qualifyContent(
  apiKey: string,
  transport?: ProviderTransport,
) {
  const title = "Morning",
    lyrics = "A quiet morning and a friendly hello.";
  const moderation = await moderateText(
    title,
    lyrics,
    apiKey,
    async () => {},
    transport,
  );
  insist(
    moderation.results.every((r) => !r.adult),
    "content_moderation_control_failed",
    503,
  );
  const classification = await classifyLyrics(
    title,
    lyrics,
    apiKey,
    async () => {},
    transport,
  );
  const c = classification.classification;
  insist(
    c.titleRating === "general" &&
      c.lyricsRating === "general" &&
      c.explicit === false &&
      c.primaryLanguage === "en",
    "content_classification_control_failed",
    503,
  );
  return {
    profile: defaultContentProfile,
    requests: 2,
    moderation: {
      id: moderation.id,
      responseSha256: moderation.responseSha256,
    },
    classification: {
      id: classification.id,
      responseSha256: classification.responseSha256,
      result: c,
    },
  };
}
