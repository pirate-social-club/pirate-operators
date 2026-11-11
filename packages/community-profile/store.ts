import type { AccountSession, AuthContext } from "../community/accounts.ts";
import { bytes32, hashJson, insist, token } from "../community/common.ts";
import type {
  ProfileMutation,
  ProfileMutationReceipt,
  PublicProfile,
} from "./contracts.ts";

type Row = {
  author_id: string;
  revision: number | null;
  display_name: string | null;
  bio: string | null;
  avatar_ref: string | null;
  cover_ref: string | null;
};
const projection = (communityId: string, row: Row): PublicProfile => ({
  schema: "pirate.community-profile/1",
  communityId,
  authorId: row.author_id,
  revision: row.revision ?? 0,
  displayName: row.display_name,
  bio: row.bio,
  avatarRef: row.avatar_ref,
  coverRef: row.cover_ref,
});
const columns =
  "a.author_id,p.revision,p.display_name,p.bio,p.avatar_ref,p.cover_ref";

/** D1 owns authority and CAS. No metadata row is synthesized by a read. */
export class CommunityProfileStore {
  readonly db: D1Database;
  readonly context: AuthContext;
  constructor(db: D1Database, context: AuthContext) {
    this.db = db;
    this.context = context;
  }
  async assertContext() {
    bytes32(this.context.communityId);
    const identity = await this.db
      .prepare(
        "SELECT community_id,community_origin FROM application_identity WHERE id=1",
      )
      .first<{ community_id: string; community_origin: string }>();
    insist(
      identity?.community_id === this.context.communityId &&
        identity.community_origin === this.context.origin,
      "database_community_mismatch",
      503,
    );
  }
  async owner(session: AccountSession) {
    const row = await this.db
      .prepare(
        `SELECT ${columns} FROM community_accounts a LEFT JOIN community_profiles p ON p.account_id=a.account_id AND p.community_id=? WHERE a.account_id=? AND a.author_id=?`,
      )
      .bind(this.context.communityId, session.account_id, session.author_id)
      .first<Row>();
    insist(row, "profile_account_unavailable", 503);
    return projection(this.context.communityId, row);
  }
  async public(author: string) {
    bytes32(author);
    const row = await this.db
      .prepare(
        `SELECT ${columns} FROM community_accounts a LEFT JOIN community_profiles p ON p.account_id=a.account_id AND p.community_id=? WHERE a.author_id=?`,
      )
      .bind(this.context.communityId, author)
      .first<Row>();
    insist(row, "profile_not_found", 404);
    return projection(this.context.communityId, row);
  }
  async receipt(
    session: AccountSession,
    id: string,
  ): Promise<ProfileMutationReceipt | null> {
    const row = await this.db
      .prepare(
        "SELECT result_json FROM community_profile_mutations WHERE community_id=? AND account_id=? AND mutation_id=?",
      )
      .bind(this.context.communityId, session.account_id, id)
      .first<{ result_json: string | null }>();
    if (!row) return null;
    insist(row.result_json, "profile_mutation_unavailable", 503);
    return {
      schema: "pirate.community-profile-mutation/1",
      mutationId: id,
      profile: JSON.parse(row.result_json) as PublicProfile,
    };
  }
  async write(session: AccountSession, body: ProfileMutation, now: number) {
    const community = this.context.communityId,
      account = session.account_id;
    const hash = hashJson({ community, account, body });
    const command = [
      community,
      account,
      body.mutationId,
      hash,
      body.expectedRevision,
    ];
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO community_profile_mutations(community_id,account_id,mutation_id,request_hash,expected_revision)
        SELECT ?,?,?,?,? WHERE COALESCE((SELECT revision FROM community_profiles WHERE community_id=? AND account_id=?),0)=?
        AND EXISTS(SELECT 1 FROM community_sessions s JOIN credential_bindings c ON c.binding_id=s.binding_id AND c.account_id=s.account_id
          JOIN community_accounts a ON a.account_id=s.account_id WHERE s.session_hash=? AND s.account_id=? AND s.binding_id=? AND s.community_id=? AND s.community_origin=? AND s.expires_at>? AND a.author_id=?)
        ON CONFLICT DO NOTHING`,
        )
        .bind(
          ...command,
          community,
          account,
          body.expectedRevision,
          session.session_hash,
          account,
          session.binding_id,
          community,
          this.context.origin,
          now,
          session.author_id,
        ),
      this.db
        .prepare(
          `INSERT INTO community_profiles(community_id,account_id,revision,display_name,bio,avatar_ref,cover_ref)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM community_profile_mutations WHERE community_id=? AND account_id=? AND mutation_id=? AND request_hash=? AND result_json IS NULL)
        ON CONFLICT(community_id,account_id) DO UPDATE SET revision=excluded.revision,display_name=excluded.display_name,bio=excluded.bio,avatar_ref=excluded.avatar_ref,cover_ref=excluded.cover_ref WHERE community_profiles.revision=?`,
        )
        .bind(
          community,
          account,
          body.expectedRevision + 1,
          body.displayName,
          body.bio,
          body.avatarRef,
          body.coverRef,
          community,
          account,
          body.mutationId,
          hash,
          body.expectedRevision,
        ),
      this.db
        .prepare(
          `UPDATE community_profile_mutations SET result_json=(SELECT json_object('schema','pirate.community-profile/1','communityId',p.community_id,'authorId',a.author_id,'revision',p.revision,'displayName',p.display_name,'bio',p.bio,'avatarRef',p.avatar_ref,'coverRef',p.cover_ref) FROM community_profiles p JOIN community_accounts a ON a.account_id=p.account_id WHERE p.community_id=? AND p.account_id=? AND p.revision=?) WHERE community_id=? AND account_id=? AND mutation_id=? AND request_hash=? AND result_json IS NULL`,
        )
        .bind(
          community,
          account,
          body.expectedRevision + 1,
          community,
          account,
          body.mutationId,
          hash,
        ),
    ]);
    const saved = await this.db
      .prepare(
        "SELECT request_hash,result_json FROM community_profile_mutations WHERE community_id=? AND account_id=? AND mutation_id=?",
      )
      .bind(community, account, body.mutationId)
      .first<{ request_hash: string; result_json: string | null }>();
    if (!saved) {
      const live = await this.db
        .prepare(
          "SELECT 1 AS valid FROM community_sessions WHERE session_hash=? AND account_id=? AND expires_at>?",
        )
        .bind(session.session_hash, account, now)
        .first();
      insist(live, "session_required", 401);
      insist(false, "profile_revision_conflict", 409);
    }
    insist(saved.request_hash === hash, "profile_mutation_conflict", 409);
    insist(saved.result_json, "profile_mutation_unavailable", 503);
    return {
      schema: "pirate.community-profile-mutation/1" as const,
      mutationId: body.mutationId,
      profile: JSON.parse(saved.result_json) as PublicProfile,
    };
  }
  async page<
    T extends { manifest: { postId: string }; transactionHash: string },
  >(
    author: string,
    items: readonly T[],
    limit: number,
    cursor: string | null,
    profileRevision: number,
    now: number,
  ) {
    const community = this.context.communityId,
      snapshot = hashJson({
        community,
        author,
        profileRevision,
        publications: items.map((item) => [
          item.manifest.postId,
          item.transactionHash,
        ]),
      });
    let offset = 0;
    if (cursor !== null) {
      insist(/^[0-9a-f]{64}$/.test(cursor), "invalid_profile_cursor");
      const row = await this.db
        .prepare(
          "SELECT community_id,author_id,snapshot_hash,page_offset,page_size,expires_at FROM community_profile_activity_cursors WHERE token=?",
        )
        .bind(cursor)
        .first<{
          community_id: string;
          author_id: string;
          snapshot_hash: string;
          page_offset: number;
          page_size: number;
          expires_at: number;
        }>();
      insist(
        row &&
          row.community_id === community &&
          row.author_id === author &&
          row.page_size === limit,
        "invalid_profile_cursor",
      );
      insist(row.expires_at > now, "profile_cursor_expired", 410);
      insist(row.snapshot_hash === snapshot, "profile_activity_changed", 409);
      offset = row.page_offset;
      insist(offset > 0 && offset < items.length, "invalid_profile_cursor");
    }
    let nextCursor: string | null = null;
    if (offset + limit < items.length) {
      const expires = (Math.floor(now / 600_000) + 1) * 600_000;
      const next = offset + limit;
      await this.db.batch([
        this.db
          .prepare(
            "DELETE FROM community_profile_activity_cursors WHERE expires_at<=?",
          )
          .bind(now),
        this.db
          .prepare(
            "INSERT INTO community_profile_activity_cursors(token,community_id,author_id,snapshot_hash,page_offset,page_size,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
          )
          .bind(token(), community, author, snapshot, next, limit, expires),
      ]);
      const row = await this.db
        .prepare(
          "SELECT token FROM community_profile_activity_cursors WHERE community_id=? AND author_id=? AND snapshot_hash=? AND page_offset=? AND page_size=? AND expires_at=?",
        )
        .bind(community, author, snapshot, next, limit, expires)
        .first<{ token: string }>();
      insist(row, "profile_cursor_unavailable", 503);
      nextCursor = row.token;
    }
    return { items: items.slice(offset, offset + limit), nextCursor };
  }
}
