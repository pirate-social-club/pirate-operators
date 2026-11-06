// Official request shape: https://elevenlabs.io/docs/api-reference/forced-alignment/create
// Centralized-source boundary: api-next f017e801, ElevenLabs alignment adapter.
import { sha256 } from "viem";
import { insist, MAX_AUDIO_BYTES } from "../community/common.ts";
import {
  validateLyrics,
  type LyricManifest,
} from "../community/lyric-manifest.ts";
import { readMp3Probe } from "../moderation/mp3-windows.ts";
import {
  providerRequest,
  type ProviderResponse,
  type ProviderTransport,
} from "../moderation/provider-http.ts";
import { ALIGNMENT_RESPONSE_BYTES } from "./limits.ts";

/** One non-idempotent upstream send. The owning operation must persist running
 * first and must never repeat this call after an ambiguous response. */
export async function sendAlignment(input: {
  vocal: Uint8Array;
  vocalSha256: `0x${string}`;
  durationMs: number;
  lyrics: LyricManifest;
  apiKey: string;
  deadline: number;
  authorize(): Promise<void>;
  received(receipt: ProviderResponse): Promise<void>;
  transport: ProviderTransport;
}) {
  const lyrics = validateLyrics(input.lyrics),
    remaining = input.deadline - Date.now();
  insist(
    input.vocal.byteLength > 0 &&
      input.vocal.byteLength <= MAX_AUDIO_BYTES &&
      sha256(input.vocal) === input.vocalSha256,
    "alignment_vocal_mismatch",
    409,
  );
  insist(remaining > 0 && remaining <= 120000, "alignment_window_expired", 409);
  const probe = await readMp3Probe(
    new Blob([Uint8Array.from(input.vocal)]).stream(),
    3600000,
    AbortSignal.timeout(Math.min(30000, remaining)),
  );
  insist(
    probe.durationMs === input.durationMs,
    "alignment_duration_mismatch",
    409,
  );
  insist(
    /^[\x21-\x7e]{16,16384}$/.test(input.apiKey),
    "alignment_key_unavailable",
    503,
  );
  insist(Date.now() < input.deadline, "alignment_window_expired", 409);
  const multipart = alignmentMultipart(input.vocal, lyrics.sourceText);
  const request = new Request("https://api.elevenlabs.io/v1/forced-alignment", {
    method: "POST",
    redirect: "manual",
    headers: {
      "xi-api-key": input.apiKey,
      "content-type": multipart.contentType,
    },
    body: multipart.body,
    signal: AbortSignal.timeout(Math.max(1, input.deadline - Date.now())),
  });
  await input.authorize();
  insist(Date.now() < input.deadline, "alignment_window_expired", 409);
  return providerRequest(
    request,
    input.transport,
    input.received,
    ALIGNMENT_RESPONSE_BYTES,
  );
}

/**
 * api-next a5c63b8db01d4359344d33c31d294a00fbeadb20
 * media-providers/elevenlabs-alignment-request.ts
 * encodeElevenLabsAlignmentMultipart: the body is written byte for byte, so
 * the transcript reaches the provider exactly. FormData serialization
 * normalizes line breaks to CRLF, and the response's characters would then no
 * longer reproduce the published lyric text.
 */
export function alignmentMultipart(vocal: Uint8Array, transcript: string) {
  const encoder = new TextEncoder(),
    random = crypto.getRandomValues(new Uint8Array(18)),
    boundary = `pirate-elevenlabs-alignment-${[...random]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`,
    text = encoder.encode(transcript);
  insist(
    !containsBytes(text, encoder.encode(boundary)),
    "alignment_boundary_collision",
    503,
  );
  const parts = [
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="vocals.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ),
      vocal,
      encoder.encode("\r\n"),
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n`,
      ),
      text,
      encoder.encode(`\r\n--${boundary}--\r\n`),
    ],
    body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
function containsBytes(haystack: Uint8Array, needle: Uint8Array) {
  outer: for (let i = 0; i + needle.byteLength <= haystack.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++)
      if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
