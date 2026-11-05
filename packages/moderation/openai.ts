// Independently owned bounded adapters, with pinned providers/models. Consult
// docs/moderation-source-provenance.json for source and official API references.
import { exact, insist, object, text } from "../community/common.ts";
import {
  providerFetch,
  providerJson,
  providerRequest,
  type ProviderResponse,
  type ProviderTransport,
} from "./provider-http.ts";
import {
  contentProfile,
  defaultContentProfile,
  classificationInstructions,
  type ContentProfile,
} from "./content-profile.ts";
export const MODERATION_MODEL = defaultContentProfile.moderationModel;
export const CLASSIFICATION_MODEL = defaultContentProfile.classificationModel;
export const categories = [
  "harassment",
  "harassment/threatening",
  "hate",
  "hate/threatening",
  "illicit",
  "illicit/violent",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "sexual",
  "sexual/minors",
  "violence",
  "violence/graphic",
] as const;
const keyHeader = (apiKey: string) => {
  insist(apiKey.length > 0, "openai_credentials_missing", 503);
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
};
type Received = (response: ProviderResponse) => Promise<void>;

export async function moderateText(
  title: string,
  lyrics: string,
  apiKey: string,
  received: Received,
  transport: ProviderTransport = providerFetch,
  profile: ContentProfile = defaultContentProfile,
) {
  profile = contentProfile(profile);
  text(title, 200);
  text(lyrics, 32768);
  const inputs = [title, ...(lyrics.trim() ? [lyrics] : [])];
  const request = new Request("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: keyHeader(apiKey),
    body: JSON.stringify({ model: profile.moderationModel, input: inputs }),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  return parseTextModeration(
    await providerRequest(request, transport, received),
    inputs.length,
    profile,
  );
}
export function parseTextModeration(
  response: ProviderResponse,
  count: number,
  profile: ContentProfile = defaultContentProfile,
) {
  const body = providerJson(response),
    id = text(body.id, 256);
  insist(
    id.length > 0 &&
      body.model === profile.moderationModel &&
      Array.isArray(body.results) &&
      body.results.length === count,
    "invalid_openai_moderation",
    503,
  );
  const results = body.results.map((value) => {
    const result = object(value),
      flags = object(result.categories),
      scores = object(result.category_scores),
      applied = object(result.category_applied_input_types);
    exact(flags, categories);
    exact(scores, categories);
    exact(applied, categories);
    insist(
      typeof result.flagged === "boolean",
      "invalid_openai_moderation",
      503,
    );
    for (const category of categories) {
      insist(
        typeof flags[category] === "boolean" &&
          typeof scores[category] === "number" &&
          Number.isFinite(scores[category]) &&
          scores[category] >= 0 &&
          scores[category] <= 1 &&
          Array.isArray(applied[category]) &&
          applied[category].every((kind) => kind === "text") &&
          (!flags[category] || applied[category].includes("text")),
        "invalid_openai_moderation",
        503,
      );
    }
    insist(
      result.flagged === categories.some((c) => flags[c]),
      "inconsistent_openai_moderation",
      503,
    );
    return { adult: result.flagged, categories: flags, scores, applied };
  });
  return { id, results, responseSha256: response.bodySha256 };
}

const classificationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    titleRating: { type: "string", enum: ["general", "adult_18"] },
    lyricsRating: { type: "string", enum: ["general", "adult_18"] },
    explicit: { type: "boolean" },
    primaryLanguage: { type: "string" },
  },
  required: ["titleRating", "lyricsRating", "explicit", "primaryLanguage"],
};
export async function classifyLyrics(
  title: string,
  lyrics: string,
  apiKey: string,
  received: Received,
  transport: ProviderTransport = providerFetch,
  profile: ContentProfile = defaultContentProfile,
) {
  profile = contentProfile(profile);
  text(title, 200);
  text(lyrics, 32768);
  const request = new Request("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: keyHeader(apiKey),
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: profile.classificationModel,
      reasoning: { effort: "none" },
      store: false,
      max_output_tokens: 256,
      instructions: classificationInstructions,
      input: JSON.stringify({ title, lyrics }),
      text: {
        format: {
          type: "json_schema",
          name: "pirate_lyrics_classification_v1",
          strict: true,
          schema: classificationSchema,
        },
      },
    }),
  });
  return parseLyricsClassification(
    await providerRequest(request, transport, received),
    profile,
  );
}
export function parseLyricsClassification(
  response: ProviderResponse,
  profile: ContentProfile = defaultContentProfile,
) {
  const body = providerJson(response),
    id = text(body.id, 256);
  insist(
    id.length > 0 &&
      body.model === profile.classificationModel &&
      body.status === "completed" &&
      Array.isArray(body.output),
    "openai_classification_unavailable",
    503,
  );
  const texts: string[] = [];
  for (const output of body.output) {
    const item = object(output);
    if (item.type !== "message") continue;
    insist(
      item.status === "completed" &&
        item.role === "assistant" &&
        Array.isArray(item.content),
      "invalid_openai_classification",
      503,
    );
    for (const content of item.content) {
      const part = object(content);
      insist(part.type === "output_text", "openai_classification_refused", 503);
      texts.push(text(part.text, 4096));
    }
  }
  insist(texts.length === 1, "invalid_openai_classification", 503);
  const classification = object(JSON.parse(texts[0]!));
  exact(classification, [
    "titleRating",
    "lyricsRating",
    "explicit",
    "primaryLanguage",
  ]);
  insist(
    ["general", "adult_18"].includes(String(classification.titleRating)) &&
      ["general", "adult_18"].includes(String(classification.lyricsRating)) &&
      typeof classification.explicit === "boolean" &&
      typeof classification.primaryLanguage === "string" &&
      /^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(
        classification.primaryLanguage,
      ),
    "invalid_openai_classification",
    503,
  );
  return {
    id,
    classification,
    profile: contentProfile(profile),
    usage: object(body.usage),
    responseSha256: response.bodySha256,
  };
}
