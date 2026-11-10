import type {
  MediaActor,
  MediaIntent,
} from "../packages/community-media/contracts.ts";
import { MEDIA_VERSION } from "../packages/community-media/contracts.ts";
import { mediaPlayback } from "../packages/community-media/playback.ts";
import {
  MAX_MEDIA_BYTES,
  MediaError,
  mediaText,
  readMediaBody,
  requireMedia,
} from "../packages/community-media/validation.ts";
import type { CommunityMedia } from "./community-media.ts";
import { CommunityError } from "../packages/community/common.ts";

export interface MediaHttpAuthorization {
  /** Existing accountSession / authenticatedWrite. No new authentication system. */
  actor(request: Request, write: boolean): Promise<MediaActor | null>;
  origin: string;
}
export async function communityMediaApi(
  request: Request,
  service: CommunityMedia,
  auth: MediaHttpAuthorization,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/media" && !url.pathname.startsWith("/api/media/"))
    return;
  const headers = {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  try {
    const write = !["GET", "HEAD"].includes(request.method);
    if (write)
      requireMedia(
        request.headers.get("origin") === auth.origin,
        "media_origin_forbidden",
        403,
      );
    if (url.pathname === "/api/media/feed" && request.method === "GET")
      return Response.json(
        await service.feed(
          Number(url.searchParams.get("limit") ?? 20),
          url.searchParams.get("cursor") ?? undefined,
        ),
        { headers },
      );
    const actor = await auth.actor(request, write);
    if (url.pathname === "/api/media/capability" && request.method === "GET") {
      requireMedia(actor, "media_authentication_required", 401);
      const song = await service.ports.song(
        mediaText(url.searchParams.get("songKey")),
        Number(url.searchParams.get("songRevision")),
      );
      requireMedia(
        song.communityId === service.communityId,
        "media_wrong_community",
        403,
      );
      const publicPosting = await service.capability(actor, song);
      return Response.json(
        {
          version: MEDIA_VERSION,
          publicPosting,
          privateReview: { allowed: true, reason: "active_account" },
        },
        { headers },
      );
    }
    if (url.pathname === "/api/media" && request.method === "POST") {
      requireMedia(actor, "media_authentication_required", 401);
      const bytes = await readMediaBody(request, 8192);
      let intent: MediaIntent;
      try {
        intent = JSON.parse(new TextDecoder().decode(bytes)) as MediaIntent;
      } catch {
        throw new MediaError("invalid_media_intent");
      }
      return Response.json(await service.reserve(actor, intent), {
        status: 201,
        headers,
      });
    }
    const match =
      /^\/api\/media\/([a-f0-9-]{36})(?:\/(upload|playback|retry|revoke))?$/.exec(
        url.pathname,
      );
    requireMedia(match, "media_not_found", 404);
    const [, id, action] = match;
    if (action === "playback")
      return await mediaPlayback(request, service, id!, actor);
    requireMedia(actor, "media_authentication_required", 401);
    if (!action && request.method === "GET")
      return Response.json(await service.status(id!, actor), { headers });
    if (!action && request.method === "DELETE")
      return Response.json(await service.withdraw(id!, actor), { headers });
    if (action === "upload" && request.method === "PUT") {
      // Authorize ownership before reading the bounded request body.
      const record = await service.owned(id!, actor);
      const bytes = await readMediaBody(
        request,
        Math.min(record.sourceBytes, MAX_MEDIA_BYTES),
      );
      return Response.json(await service.upload(id!, actor, bytes), {
        headers,
      });
    }
    if (action === "retry" && request.method === "POST")
      return Response.json(await service.retry(id!, actor), { headers });
    if (action === "revoke" && request.method === "POST") {
      await service.revoke(id!, actor);
      return new Response(null, { status: 204, headers });
    }
    throw new MediaError("method_not_allowed", 405);
  } catch (error) {
    const known =
      error instanceof MediaError || error instanceof CommunityError;
    return Response.json(
      { error: known ? error.code : "media_service_unavailable" },
      { status: known ? error.status : 503, headers },
    );
  }
}
