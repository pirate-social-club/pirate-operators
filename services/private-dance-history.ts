import type { AuthContext } from "../packages/community/accounts.ts";
import { CommunityError, insist } from "../packages/community/common.ts";
import type { MediaRecord } from "../packages/community-media/contracts.ts";
import { DancePrivateRequestSession } from "./dance-private-session.ts";
import type { DanceSource3Bindings } from "./dance-source3-bindings.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";

// The same Source 3 check used by playback may reject individual stale rows.
// Other errors describe unavailable authority or infrastructure for the page.
const changedResource = new Set([
  "dance_source3_preview_denied",
  "dance_source3_media_changed",
  "dance_source3_original_missing",
  "dance_selection_missing",
  "dance_selection_changed",
  "dance_preparation_target_changed",
  "dance_publication_missing",
  "dance_publication_quarantined",
  "dance_publication_changed",
  "dance_captured_inputs_changed",
  "dance_offer_changed",
  "dance_offer_closed",
  "dance_fence_changed",
]);

export async function privateDanceHistory(
  request: Request,
  context: AuthContext,
  headers: Headers,
  db: D1Database,
  source: DanceSource3Bindings,
  current?: () => Promise<void>,
) {
  insist(request.method === "GET", "method_not_allowed", 405);
  const session = await DancePrivateRequestSession.open(request, db, context);
  const cursor = new URL(request.url).searchParams.get("before");
  const match = cursor?.match(/^(\d{1,16})_([a-f0-9-]{36})$/);
  insist(
    cursor === null || (match && Number.isSafeInteger(Number(match[1]))),
    "dance_invalid_cursor",
    400,
  );
  const before = Number(match?.[1] ?? Number.MAX_SAFE_INTEGER),
    lastId = match?.[2] ?? "";
  const result = await db
    .prepare(
      `SELECT m.body, json_extract(p.manifest_json,'$.title') AS title
    FROM community_media m JOIN dance_source3_requests d ON m.community_id=d.community_id
      AND m.account_id=d.account_id AND m.request_id=d.request_id
    JOIN dance_captures c ON c.capture_id=d.capture_id AND c.community_id=m.community_id AND c.account_id=m.account_id
    JOIN dance_host_song_keys k ON k.community_id=m.community_id AND k.song_key=json_extract(m.body,'$.songKey')
    JOIN public_post_revisions p ON p.community_id=k.community_id AND p.post_id=k.post_id
      AND p.revision=json_extract(m.body,'$.songRevision') AND p.quarantined=0
    WHERE m.community_id=? AND m.account_id=? AND m.purpose='private-review' AND m.state='ready'
      AND m.expires_at>${DANCE_DB_NOW} AND COALESCE(json_extract(m.body,'$.erasePending'),0)=0
      AND json_extract(m.body,'$.submissionId') IS NULL AND json_extract(c.capture_json,'$.publication.kind')='private'
      AND (m.ready_at<? OR (m.ready_at=? AND m.id<?)) ORDER BY m.ready_at DESC,m.id DESC LIMIT 6`,
    )
    .bind(context.communityId, session.actor.accountId, before, before, lastId)
    .all<{ body: string; title: string }>();
  const records = [];
  let last: { readyAt: number; id: string } | undefined;
  for (const row of result.results.slice(0, 5)) {
    const media = JSON.parse(row.body) as MediaRecord;
    last = { readyAt: media.readyAt!, id: media.id };
    try {
      await source.preview(session.actor, media);
    } catch (error) {
      if (
        !(error instanceof CommunityError) ||
        !changedResource.has(error.code)
      )
        throw error;
      await session.check();
      continue;
    }
    records.push({
      id: media.id,
      title: row.title,
      readyAt: media.readyAt!,
      expiresAt: media.expiresAt,
    });
  }
  await current?.();
  await session.check();

  const security = new Headers(headers);
  security.set("cache-control", "private, no-store");
  security.set("vary", "Cookie");
  return Response.json(
    {
      communityId: context.communityId,
      accountId: session.actor.accountId,
      records,
      next:
        result.results.length > 5 && last ? last.readyAt + "_" + last.id : null,
    },
    { headers: security },
  );
}
