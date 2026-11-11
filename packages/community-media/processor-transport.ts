import type {
  MediaProcessor,
  MediaRecord,
  PublishedMediaSong,
  RenditionFacts,
} from "./contracts.ts";
import {
  MAX_MEDIA_BYTES,
  MediaError,
  readMediaBody,
  requireMedia,
  sameBinding,
} from "./validation.ts";

/** Private Fetcher binding / authenticated managed runner, never a browser API.
 * The caller must provide a trusted transport, not a URL from user input.
 */
export class BoundMediaProcessor implements MediaProcessor {
  readonly transport: Pick<Fetcher, "fetch">;
  constructor(transport: Pick<Fetcher, "fetch">) {
    this.transport = transport;
  }
  async render(
    source: Uint8Array,
    media: MediaRecord,
    song: PublishedMediaSong,
  ) {
    const metadata = new TextEncoder().encode(JSON.stringify({ media, song }));
    requireMedia(
      metadata.byteLength <= 8192 && source.byteLength <= MAX_MEDIA_BYTES,
      "media_processor_request_invalid",
    );
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, metadata.byteLength);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(header);
        controller.enqueue(metadata);
        controller.enqueue(source);
        controller.close();
      },
    });
    const response = await this.transport.fetch(
      "https://community-media.internal/render",
      {
        method: "POST",
        headers: { "content-type": "application/vnd.pirate.media-render-v1" },
        body,
      },
    );
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new MediaError(
        value.error && /^media_[a-z_]+$/.test(value.error)
          ? value.error
          : "media_processing_failed",
        503,
      );
    }
    const encoded = response.headers.get("x-media-facts");
    requireMedia(
      encoded && encoded.length <= 8192,
      "media_rendition_invalid",
      422,
    );
    const facts = JSON.parse(encoded) as RenditionFacts;
    const bytes = await readMediaBody({ body: response.body }, MAX_MEDIA_BYTES);
    return { bytes, facts };
  }
}

export interface MediaRenderAuthority {
  /** Must authenticate the private runner's service identity on every call. */
  authorize(request: Request): Promise<boolean>;
  /** Re-read current lifecycle/claim; prevents stale or client-invented jobs. */
  current(communityId: string, id: string): Promise<MediaRecord>;
  song(
    communityId: string,
    key: string,
    revision: number,
  ): Promise<PublishedMediaSong>;
  now(): number;
}
/** Node host calls this Web Request handler with FFmpegMediaProcessor. The
 * community owns the host. No unauthenticated route or host is provisioned.
 */
export async function communityMediaRender(
  request: Request,
  processor: MediaProcessor,
  authority: MediaRenderAuthority,
): Promise<Response> {
  try {
    requireMedia(
      await authority.authorize(request),
      "media_processor_forbidden",
      403,
    );
    requireMedia(
      request.method === "POST" && new URL(request.url).pathname === "/render",
      "media_not_found",
      404,
    );
    const bytes = await readMediaBody(request, MAX_MEDIA_BYTES + 8196);
    requireMedia(bytes.byteLength >= 4, "media_processor_request_invalid");
    const size = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    requireMedia(
      size > 0 && size <= 8192 && bytes.byteLength > size + 4,
      "media_processor_request_invalid",
    );
    const input = JSON.parse(
      new TextDecoder().decode(bytes.subarray(4, size + 4)),
    ) as { media: MediaRecord; song: PublishedMediaSong };
    const record = await authority.current(
      input.media.communityId,
      input.media.id,
    );
    requireMedia(
      record.state === "processing" &&
        record.claim === input.media.claim &&
        record.revision === input.media.revision &&
        (record.leaseUntil ?? 0) > authority.now() &&
        record.expiresAt > authority.now() &&
        sameBinding(record, input.media),
      "media_state_changed",
      409,
    );
    const song = await authority.song(
      record.communityId,
      record.songKey,
      record.songRevision,
    );
    requireMedia(
      song.communityId === record.communityId &&
        song.songKey === record.songKey &&
        song.songRevision === record.songRevision &&
        song.audioSha256 === record.audioSha256,
      "media_song_revision_changed",
      409,
    );
    const result = await processor.render(
      bytes.subarray(size + 4),
      record,
      song,
    );
    // Ready commit and digest verification remain in the authoritative worker.
    return new Response(new Uint8Array(result.bytes), {
      headers: {
        "content-type": "video/mp4",
        "x-media-facts": JSON.stringify(result.facts),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const known = error instanceof MediaError;
    return Response.json(
      { error: known ? error.code : "media_processing_failed" },
      {
        status: known ? error.status : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
