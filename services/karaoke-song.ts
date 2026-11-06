// Karaoke material for a published song in the community application: one
// forced alignment per lyric revision, the timed Karaoke manifest built from
// it, and the private stems a signed-in learner sings with.
import { recoverMessageAddress, sha256, type Hex } from "viem";
import {
  bytes32,
  canonical,
  exact,
  hashJson,
  insist,
  integer,
  object,
} from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { LyricManifest } from "../packages/community/lyric-manifest.ts";
import { alignmentOperation } from "../packages/alignment/operation.ts";
import { sendAlignment } from "../packages/alignment/elevenlabs.ts";
import { alignmentResult } from "../packages/alignment/elevenlabs-response.ts";
import {
  providerFetch,
  providerJson,
  type ProviderTransport,
} from "../packages/moderation/provider-http.ts";
import { publishedKaraokeManifest } from "../packages/karaoke/published-manifest.ts";
import type { KaraokeManifest } from "../packages/protocol/payments.ts";
import {
  publicLyricManifest,
  publicSongs,
  type PublicReadPorts,
} from "./community-public.ts";

/** The operator quote's segment limit; a longer sung line cannot be sold. */
export const KARAOKE_MAX_SEGMENT_MS = 10000;
/** An alignment request is short-lived controller authority for one send. */
export const ALIGNMENT_REQUEST_LIFETIME_S = 600;

export async function publishedLyrics(
  db: D1Database,
  config: CommunityConfig,
  reads: PublicReadPorts,
  postId: Hex,
): Promise<LyricManifest> {
  const records = await publicSongs(db, config, reads, postId);
  insist(records.length === 1, "public_song_not_found", 404);
  const lyrics = await publicLyricManifest(records[0]!.post, reads.transport);
  insist(lyrics, "karaoke_lyrics_unavailable", 404);
  return lyrics;
}

export interface PublishedStem {
  object_key: string;
  object_etag: string;
  sha256: Hex;
  byte_length: number;
  duration_ms: number;
}
/** A sealed stem of a published submission, by the same rule as the vocal capability. */
export async function publishedStem(
  db: D1Database,
  communityId: Hex,
  postId: Hex,
  slot: "vocals" | "instrumental",
) {
  const stem = await db
    .prepare(
      `SELECT m.object_key,m.object_etag,m.sha256,m.byte_length,m.duration_ms,j.authority_json
    FROM media_stems m JOIN media_submissions s ON s.submission_id=m.submission_id
    JOIN publication_jobs j ON j.submission_id=s.submission_id
    WHERE s.post_id=? AND s.upload_state='sealed' AND j.phase='published'
    AND m.slot=? AND m.state='sealed'`,
    )
    .bind(postId, slot)
    .first<PublishedStem & { authority_json: string }>();
  insist(
    stem &&
      object(JSON.parse(stem.authority_json)).communityId === communityId &&
      Number.isSafeInteger(stem.duration_ms) &&
      stem.duration_ms > 0,
    "published_stem_unavailable",
    404,
  );
  return stem;
}
async function stemBytes(media: R2Bucket, stem: PublishedStem) {
  const stored = await media.get(stem.object_key);
  insist(
    stored &&
      stored.etag === stem.object_etag &&
      stored.size === stem.byte_length &&
      stored.customMetadata?.sha256 === stem.sha256,
    "published_stem_changed",
    503,
  );
  return stored;
}

export interface AlignmentRequest {
  schema: "pirate.song-alignment-request/1";
  communityId: Hex;
  postId: Hex;
  lyricsRevision: number;
  lyricsSha256: Hex;
  vocalSha256: Hex;
  expiresAt: number;
}
export interface SignedAlignmentRequest {
  request: AlignmentRequest;
  signature: Hex;
}
export const alignmentRequestMessage = (request: AlignmentRequest) =>
  canonical(request);

async function verifiedRequest(
  value: unknown,
  config: CommunityConfig,
  nowS: number,
): Promise<SignedAlignmentRequest> {
  const signed = object(value);
  exact(signed, ["request", "signature"]);
  const r = object(signed.request);
  exact(r, [
    "schema",
    "communityId",
    "postId",
    "lyricsRevision",
    "lyricsSha256",
    "vocalSha256",
    "expiresAt",
  ]);
  const request: AlignmentRequest = {
    schema: "pirate.song-alignment-request/1",
    communityId: bytes32(r.communityId),
    postId: bytes32(r.postId),
    lyricsRevision: integer(r.lyricsRevision, 1, Number.MAX_SAFE_INTEGER),
    lyricsSha256: bytes32(r.lyricsSha256),
    vocalSha256: bytes32(r.vocalSha256),
    expiresAt: integer(r.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
  insist(
    r.schema === request.schema &&
      request.communityId === config.communityId &&
      request.expiresAt > nowS &&
      request.expiresAt <= nowS + ALIGNMENT_REQUEST_LIFETIME_S,
    "invalid_alignment_request",
    409,
  );
  insist(
    typeof signed.signature === "string" &&
      /^0x[0-9a-f]{130}$/.test(signed.signature),
    "invalid_alignment_signature",
    403,
  );
  // Only the community controller, the publishing owner, buys an alignment.
  const signer = await recoverMessageAddress({
    message: alignmentRequestMessage(request),
    signature: signed.signature as Hex,
  });
  insist(
    signer.toLowerCase() === config.controller,
    "untrusted_alignment_controller",
    403,
  );
  return { request, signature: signed.signature as Hex };
}

export interface AlignmentRunPorts {
  beforeSend?: () => Promise<void>;
  apiKey?: string;
  transport?: ProviderTransport;
  now?: () => number;
}
/**
 * Runs, resumes or reports the one forced alignment of a published lyric
 * revision. The controller's short-lived signed request authorizes the send;
 * the operation identity, not the request, bounds it to one purchase.
 */
export async function runSongAlignment(
  db: D1Database,
  media: R2Bucket,
  config: CommunityConfig,
  reads: PublicReadPorts,
  value: unknown,
  ports: AlignmentRunPorts,
) {
  const now = ports.now ?? Date.now,
    signed = await verifiedRequest(value, config, Math.floor(now() / 1000)),
    { request } = signed,
    lyrics = await publishedLyrics(db, config, reads, request.postId);
  insist(
    hashJson(lyrics) === request.lyricsSha256 &&
      lyrics.revision === request.lyricsRevision,
    "alignment_lyrics_changed",
    409,
  );
  const stem = await publishedStem(
    db,
    config.communityId,
    request.postId,
    "vocals",
  );
  insist(stem.sha256 === request.vocalSha256, "alignment_vocal_changed", 409);
  const authorize = async () => {
    insist(
      Math.floor(now() / 1000) < request.expiresAt,
      "alignment_request_expired",
      409,
    );
    insist(
      typeof ports.apiKey === "string" &&
        /^[\x21-\x7e]{16,16384}$/.test(ports.apiKey),
      "alignment_key_unavailable",
      503,
    );
  };
  return alignmentOperation(
    db,
    {
      communityId: config.communityId,
      postId: request.postId,
      lyricsRevision: request.lyricsRevision,
    },
    hashJson(signed),
    {
      lyricsSha256: request.lyricsSha256,
      vocalSha256: stem.sha256,
      durationMs: stem.duration_ms,
    },
    {
      authorize,
      async send(received) {
        const stored = await stemBytes(media, stem),
          vocal = new Uint8Array(await stored.arrayBuffer());
        insist(sha256(vocal) === stem.sha256, "published_stem_changed", 503);
        await ports.beforeSend?.();
        return sendAlignment({
          vocal,
          vocalSha256: stem.sha256,
          durationMs: stem.duration_ms,
          lyrics,
          apiKey: ports.apiKey!,
          deadline: Math.min(request.expiresAt * 1000, Date.now() + 120000),
          authorize,
          received,
          transport: ports.transport ?? providerFetch,
        });
      },
      interpret(receipt) {
        const result = alignmentResult(
          providerJson(receipt),
          lyrics,
          stem.duration_ms,
        );
        return { mode: result.mode, words: result.words };
      },
    },
  );
}

/** The timed Karaoke manifest of a published song once its alignment completed. */
export async function publishedKaraoke(
  db: D1Database,
  config: CommunityConfig,
  reads: PublicReadPorts,
  postId: Hex,
): Promise<KaraokeManifest> {
  const lyrics = await publishedLyrics(db, config, reads, postId),
    row = await db
      .prepare(
        "SELECT state,result_json FROM song_alignments WHERE community_id=? AND post_id=? AND lyrics_revision=?",
      )
      .bind(config.communityId, postId, lyrics.revision)
      .first<{ state: string; result_json: string | null }>();
  insist(
    row?.state === "complete" && row.result_json,
    "karaoke_timing_unavailable",
    404,
  );
  return publishedKaraokeManifest(
    lyrics,
    JSON.parse(row.result_json) as Parameters<
      typeof publishedKaraokeManifest
    >[1],
    KARAOKE_MAX_SEGMENT_MS,
  );
}

/** The instrumental stem, for a signed-in learner's Karaoke playback. */
export async function instrumentalResponse(
  db: D1Database,
  media: R2Bucket,
  config: CommunityConfig,
  postId: Hex,
) {
  const stem = await publishedStem(
      db,
      config.communityId,
      postId,
      "instrumental",
    ),
    stored = await stemBytes(media, stem);
  return new Response(stored.body, {
    headers: {
      "content-type": "audio/mpeg",
      "content-length": String(stem.byte_length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
