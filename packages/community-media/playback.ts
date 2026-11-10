import type { MediaActor } from "./contracts.ts";
import type { CommunityMedia } from "../../services/community-media.ts";
import { requireMedia } from "./validation.ts";

export async function mediaPlayback(
  request: Request,
  service: CommunityMedia,
  id: string,
  actor: MediaActor | null,
) {
  requireMedia(
    request.method === "GET" || request.method === "HEAD",
    "method_not_allowed",
    405,
  );
  const record = await service.playbackRecord(id, actor);
  requireMedia(record.renditionKey && record.rendition, "media_not_ready", 409);
  const size = record.rendition.bytes,
    range = request.headers.get("range");
  let start = 0,
    end = size - 1,
    partial = false;
  const headers = new Headers({
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  });
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: {
          ...Object.fromEntries(headers),
          "content-range": `bytes */${size}`,
        },
      });
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1]
      ? match[2]
        ? Math.min(size - 1, Number(match[2]))
        : size - 1
      : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      start >= size ||
      (!match[1] && Number(match[2]) === 0)
    ) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    partial = true;
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("content-length", String(end - start + 1));
  // HEAD also verifies object existence; original bytes never substitute.
  if (request.method === "HEAD") {
    requireMedia(
      await service.ports.bucket.head(record.renditionKey),
      "media_rendition_missing",
      503,
    );
    return new Response(null, { status: partial ? 206 : 200, headers });
  }
  const object = await service.ports.bucket.get(record.renditionKey, {
    range: { offset: start, length: end - start + 1 },
  });
  requireMedia(object, "media_rendition_missing", 503);
  return new Response(object.body, { status: partial ? 206 : 200, headers });
}
