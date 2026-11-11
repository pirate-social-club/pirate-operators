import type {
  MediaBinding,
  MediaDurationPolicy,
  MediaIntent,
  MediaRecord,
  PublishedMediaSong,
  ReadyMedia,
} from "./contracts.ts";
export const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
export const SAMPLE_RATE = 48_000;
export const PRIVATE_RETENTION_MS = 7 * 86_400_000;
export const UNSUBMITTED_TTL_MS = 2 * 86_400_000;
export const PUBLIC_RETENTION_MS = 30 * 86_400_000;
export const MAX_ATTEMPTS = 3;
export class MediaError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function requireMedia(
  ok: unknown,
  code: string,
  status = 400,
): asserts ok {
  if (!ok) throw new MediaError(code, status);
}
export function mediaText(value: unknown, max = 256): string {
  requireMedia(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      !/[\x00-\x1f\x7f]/.test(value),
    "invalid_media_text",
  );
  return value;
}
export function digest(value: unknown): string {
  requireMedia(
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
    "invalid_media_digest",
  );
  return value;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(result), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function integer(value: unknown, min: number, max: number): number {
  requireMedia(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
    "invalid_media_integer",
  );
  return value;
}
export const SONG_CLIP_POLICY: MediaDurationPolicy = Object.freeze({
  version: "song-clip/1",
  minSamples: 3 * SAMPLE_RATE,
  maxSamples: 15 * SAMPLE_RATE,
});
export function validateIntent(
  raw: MediaIntent,
  song: PublishedMediaSong,
  policy = SONG_CLIP_POLICY,
) {
  requireMedia(raw && typeof raw === "object", "invalid_media_intent");
  requireMedia(
    /^[a-zA-Z0-9_-]{8,80}$/.test(raw.requestId),
    "invalid_media_request_id",
  );
  mediaText(raw.songKey);
  digest(raw.recordingSha256);
  integer(raw.songRevision, 1, Number.MAX_SAFE_INTEGER);
  integer(raw.bytes, 1, MAX_MEDIA_BYTES);
  integer(raw.startSample, 0, Number.MAX_SAFE_INTEGER);
  mediaText(policy.version, 128);
  integer(policy.minSamples, SAMPLE_RATE, 180 * SAMPLE_RATE);
  integer(policy.maxSamples, policy.minSamples, 180 * SAMPLE_RATE);
  integer(raw.durationSamples, policy.minSamples, policy.maxSamples);
  requireMedia(
    raw.purpose === "public-feed" || raw.purpose === "private-review",
    "invalid_media_purpose",
  );
  requireMedia(typeof raw.publicConsent === "boolean", "invalid_media_consent");
  requireMedia(
    raw.purpose !== "public-feed" || raw.publicConsent,
    "media_public_consent_required",
    403,
  );
  requireMedia(
    raw.songKey === song.songKey && raw.songRevision === song.songRevision,
    "media_song_revision_changed",
    409,
  );
  integer(song.durationSamples, 1, Number.MAX_SAFE_INTEGER);
  digest(song.audioSha256);
  requireMedia(
    raw.startSample + raw.durationSamples <= song.durationSamples,
    "media_song_interval_uncovered",
  );
}
export function sameBinding(a: MediaBinding, b: MediaBinding): boolean {
  return (
    [
      "communityId",
      "accountId",
      "songKey",
      "songRevision",
      "audioSha256",
      "recordingSha256",
      "startSample",
      "durationSamples",
      "mediaPolicyVersion",
    ] as const
  ).every((key) => a[key] === b[key]);
}
export function readyFacts(record: MediaRecord): ReadyMedia {
  requireMedia(
    record.state === "ready" &&
      record.rendition &&
      record.readyAt !== undefined,
    "media_not_ready",
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
    version,
    id,
    revision,
    purpose,
    rendition,
    readyAt,
    expiresAt,
    submissionId,
    trustedSubmittedAtMs,
    reviewDeadlineMs,
  } = record;
  return {
    communityId,
    accountId,
    songKey,
    songRevision,
    audioSha256,
    recordingSha256,
    startSample,
    durationSamples,
    mediaPolicyVersion,
    version,
    id,
    revision,
    purpose,
    rendition: { ...rendition },
    readyAt,
    expiresAt,
    submissionId,
    trustedSubmittedAtMs,
    reviewDeadlineMs,
  };
}
export function terminal(record: MediaRecord) {
  return ["withdrawn", "revoked", "expired"].includes(record.state);
}
/** Bounded even when Content-Length is missing or dishonest. */
export async function readMediaBody(
  request: { body: ReadableStream<Uint8Array> | null },
  max: number,
): Promise<Uint8Array> {
  requireMedia(request.body, "media_body_required");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      requireMedia(total <= max, "media_too_large", 413);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
