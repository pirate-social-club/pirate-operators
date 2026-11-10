import type {
  MediaQuota,
  MediaRecord,
  MediaReviewWitness,
} from "./contracts.ts";
import { requireMedia } from "./validation.ts";

/** A fixed predicate from the admitted runtime, never from browser input. */
export interface MediaReservationFence {
  sql: string;
  values: (string | number | null)[];
}
export class MediaRepository {
  readonly db: D1Database;
  readonly communityId: string;
  constructor(db: D1Database, communityId: string) {
    this.db = db;
    this.communityId = communityId;
  }
  async get(id: string): Promise<MediaRecord> {
    const row = await this.db
      .prepare("SELECT body FROM community_media WHERE id=? AND community_id=?")
      .bind(id, this.communityId)
      .first<{ body: string }>();
    requireMedia(row, "media_not_found", 404);
    return JSON.parse(row.body) as MediaRecord;
  }
  async reserve(
    record: MediaRecord,
    quota: MediaQuota = {
      perAccount: 5,
      perCommunity: 100,
      bytesPerCommunity: 1024 * 1024 * 1024,
    },
    fence?: MediaReservationFence,
  ): Promise<MediaRecord> {
    for (const value of Object.values(quota))
      requireMedia(
        Number.isSafeInteger(value) && value > 0,
        "media_quota_unconfigured",
        503,
      );
    // Capacity is reserved in the same statement as intent. Uncollected and
    // pending-erasure bytes retain capacity until the recovery sweep removes them.
    const active =
      "(state NOT IN ('withdrawn','revoked','expired') OR json_extract(body,'$.erasePending')=1)";
    const guard = fence ? `AND (${fence.sql})` : "";
    if (fence)
      requireMedia(
        fence.sql.trim(),
        "media_reservation_fence_unavailable",
        503,
      );
    await this.db
      .prepare(
        `INSERT INTO community_media(id,community_id,account_id,request_id,revision,state,purpose,expires_at,body)
      SELECT ?,?,?,?,?,?,?,?,? WHERE
      (SELECT count(*) FROM community_media WHERE community_id=? AND account_id=? AND ${active}) < ? AND
      (SELECT count(*) FROM community_media WHERE community_id=? AND ${active}) < ? AND
      (SELECT coalesce(sum(json_extract(body,'$.sourceBytes')),0) FROM community_media WHERE community_id=? AND ${active}) + ? <= ?
      ${guard} ON CONFLICT(community_id,account_id,request_id) DO NOTHING`,
      )
      .bind(
        record.id,
        record.communityId,
        record.accountId,
        record.requestId,
        record.revision,
        record.state,
        record.purpose,
        record.expiresAt,
        JSON.stringify(record),
        this.communityId,
        record.accountId,
        quota.perAccount,
        this.communityId,
        quota.perCommunity,
        this.communityId,
        record.sourceBytes,
        quota.bytesPerCommunity,
        ...(fence?.values ?? []),
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT body FROM community_media WHERE community_id=? AND account_id=? AND request_id=? ${guard}`,
      )
      .bind(
        this.communityId,
        record.accountId,
        record.requestId,
        ...(fence?.values ?? []),
      )
      .first<{ body: string }>();
    if (!row && fence) {
      const allowed = await this.db
        .prepare(`SELECT 1 AS allowed WHERE (${fence.sql})`)
        .bind(...fence.values)
        .first<{ allowed: number }>();
      requireMedia(
        allowed?.allowed === 1,
        "media_reservation_not_admitted",
        403,
      );
    }
    requireMedia(row, "media_capacity_full", 429);
    return JSON.parse(row.body) as MediaRecord;
  }
  async save(
    before: MediaRecord,
    changes: Partial<MediaRecord>,
  ): Promise<MediaRecord> {
    const next = { ...before, ...changes, revision: before.revision + 1 };
    const result = await this.db
      .prepare(
        `UPDATE community_media SET revision=?,state=?,expires_at=?,ready_at=?,body=?
      WHERE id=? AND community_id=? AND revision=?`,
      )
      .bind(
        next.revision,
        next.state,
        next.expiresAt,
        next.readyAt ?? 0,
        JSON.stringify(next),
        before.id,
        this.communityId,
        before.revision,
      )
      .run();
    requireMedia(result.meta.changes === 1, "media_state_changed", 409);
    return next;
  }
  async records(limit = 100, after = ""): Promise<MediaRecord[]> {
    const rows = await this.db
      .prepare(
        "SELECT body FROM community_media WHERE community_id=? AND id>? ORDER BY id LIMIT ?",
      )
      .bind(this.communityId, after, limit)
      .all<{ body: string }>();
    return rows.results.map((r) => JSON.parse(r.body) as MediaRecord);
  }
  async feed(
    limit: number,
    cursor?: { readyAt: number; id: string },
  ): Promise<MediaRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT body FROM community_media WHERE community_id=? AND purpose='public-feed' AND state='ready'
      AND (ready_at < ? OR (ready_at = ? AND id < ?)) ORDER BY ready_at DESC,id DESC LIMIT ?`,
      )
      .bind(
        this.communityId,
        cursor?.readyAt ?? Number.MAX_SAFE_INTEGER,
        cursor?.readyAt ?? Number.MAX_SAFE_INTEGER,
        cursor?.id ?? "~",
        limit,
      )
      .all<{ body: string }>();
    return rows.results.map((r) => JSON.parse(r.body) as MediaRecord);
  }
}

/** Embed this fixed predicate in the pending-intent INSERT ... SELECT ... WHERE.
 * Bind these values after the verdict values, never interpolate account input.
 * Reviewer delegation/identity and rules/offer gates belong in that SAME write.
 * This is not the final canonical on-chain ordering fence.
 */
export const MEDIA_COMMIT_GUARD = `EXISTS (SELECT 1 FROM community_media
  WHERE id=? AND community_id=? AND account_id=? AND revision=?
  AND purpose='private-review' AND state='ready' AND expires_at>?
  AND json_extract(body,'$.recordingSha256')=?)`;
export function mediaCommitValues(
  witness: MediaReviewWitness,
  commitAt: number,
) {
  requireMedia(
    Number.isSafeInteger(commitAt) &&
      commitAt >= 0 &&
      commitAt < witness.expiresAt,
    "media_expired",
    409,
  );
  return [
    witness.id,
    witness.communityId,
    witness.accountId,
    witness.revision,
    commitAt,
    witness.recordingSha256,
  ];
}
