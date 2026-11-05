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
  const form = new FormData();
  form.set(
    "file",
    new Blob([Uint8Array.from(input.vocal)], { type: "audio/mpeg" }),
    "vocals.mp3",
  );
  form.set("text", lyrics.sourceText);
  const request = new Request("https://api.elevenlabs.io/v1/forced-alignment", {
    method: "POST",
    redirect: "manual",
    headers: { "xi-api-key": input.apiKey },
    body: form,
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
