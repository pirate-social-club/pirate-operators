/** Fresh private profile at the same normal Dance HTTP routes. Existing V1
 * profiles retain their dispatcher; unimplemented V2 publication/review paths
 * cannot fall through to a V4 authorization or V1 contract. */
import type { AuthContext } from "../packages/community/accounts.ts";
import {
  CommunityError,
  insist,
  jsonBody,
  text,
} from "../packages/community/common.ts";
import { parseCaptureRequestV2 } from "../packages/dance/capture-v2.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { DancePrivateRequestSession } from "./dance-private-session.ts";
import { DancePrivateCaptureService } from "./dance-private-capture.ts";
import type { createDancePrivateCatalogue } from "./dance-private-catalogue.ts";
import { requireProductionTarget } from "./dance-production.ts";
import type { DancePublicationMediaAccess } from "./dance-publication-media-access.ts";

export async function dancePrivateCommunityApi(
  request: Request,
  db: D1Database,
  catalogue: ReturnType<typeof createDancePrivateCatalogue>,
  context: AuthContext,
  headers: Headers,
  publicationV2?: DancePublicationMediaAccess,
) {
  const session = await DancePrivateRequestSession.open(request, db, context),
    store = new DanceStore(db);
  const service = new DancePrivateCaptureService({
    db,
    session,
    catalogue,
    communityId: context.communityId,
  });
  const privateHeaders = new Headers(headers);
  privateHeaders.set("cache-control", "no-store, private");
  privateHeaders.set("vary", "Cookie");
  const reply = async (
    value: unknown,
    fences: readonly import("../packages/dance/contracts.ts").DanceFence[] = [],
  ) => {
    await session.check();
    await store.assert([...session.fences, ...fences]);
    await session.check();
    return Response.json(value, { headers: privateHeaders });
  };
  const url = new URL(request.url);
  if (url.pathname === "/api/dance/captures") {
    insist(request.method === "POST", "method_not_allowed", 405);
    const body = parseCaptureRequestV2(await jsonBody(request));
    if (body.publication.kind === "private") catalogue.assertPrivateTarget(body.target);
    await session.check();
    return reply(await service.capture(body));
  }
  const read =
    /^\/api\/dance\/captures\/(0x[0-9a-f]{64})\/(access|guide)$/.exec(
      url.pathname,
    );
  if (read) {
    insist(request.method === "GET", "method_not_allowed", 405);
    const bound = await publicationV2?.owned(session.actor, read[1]);
    if (bound)
      return reply(read[2] === "access"
        ? { version: "pirate.dance-capture-access/2", capture: bound.capture }
        : bound.guide, bound.fences);
    const capture = await service.access(read[1]);
    await session.check();
    return reply(
      read[2] === "access"
        ? { version: "pirate.dance-capture-access/2", capture }
        : await catalogue.guide(session.actor, capture),
    );
  }
  const song = /^\/api\/dance\/songs\/(0x[0-9a-f]{64})$/.exec(url.pathname);
  if (song) {
    insist(request.method === "GET", "method_not_allowed", 405);
    return reply({
      version: "pirate.dance-song-key/1",
      communityId: context.communityId,
      accountId: session.actor.accountId,
      postId: song[1],
      songKey: catalogue.songKeyForPost(song[1]),
      bindingOnly: true,
    });
  }
  if (url.pathname === "/api/dance/catalogue") {
    insist(request.method === "GET", "method_not_allowed", 405);
    const selected = await catalogue.list(
      session.actor,
      text(url.searchParams.get("songKey"), 128),
      url.searchParams.get("cursor"),
    );
    return reply(selected.page, selected.fences);
  }
  if (
    url.pathname === "/api/dance/reference" ||
    url.pathname === "/api/dance/latest"
  ) {
    insist(request.method === "GET", "method_not_allowed", 405);
    let target: unknown;
    try {
      target = JSON.parse(text(url.searchParams.get("target"), 2048));
    } catch {
      throw new CommunityError("dance_invalid_target");
    }
    const t = requireProductionTarget(target, context.communityId);
    if (url.pathname === "/api/dance/reference") {
      const selected = await catalogue.select(session.actor, t);
      insist(selected.referenceGrant, "dance_reference_unavailable", 404);
      return reply(selected.referenceGrant, selected.fences);
    }
    const row = await db
      .prepare(
        `SELECT r.review_id FROM dance_reviews r JOIN dance_captures c ON c.capture_id=r.review_id
      WHERE r.community_id=? AND r.account_id=? AND json_extract(c.capture_json,'$.songKey')=? LIMIT 1`,
      )
      .bind(context.communityId, session.actor.accountId, t.songKey)
      .first();
    insist(!row, "dance_v2_review_unavailable", 503);
    return reply(null);
  }
  throw new CommunityError("dance_v2_review_unavailable", 503);
}
