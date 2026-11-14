import { acceptedIntent, type AcceptedIntent } from "./intent.ts";
import {
  bytes32,
  canonical,
  CommunityError,
  insist,
  integer,
  token,
} from "../community/common.ts";
import {
  associationId,
  recordingId,
  verifiedPublication,
  exactCatalogFile,
  type Association,
  type CatalogFile,
  type CatalogStatusSnapshot,
  type Recording,
  type RecordingState,
  type VerifiedPublication,
} from "./model.ts";

/** A request/worker-local primary session; no global mutable database state. */
export class RecognitionStore {
  private readonly database: D1Database;
  readonly db: D1DatabaseSession;
  readonly namespace: string;
  readonly now: () => number;
  constructor(db: D1Database, namespace: string, now = Date.now) {
    this.database = db;
    this.db = db.withSession("first-primary");
    this.namespace = bytes32(namespace);
    this.now = now;
  }
  async get(id: string) {
    return this.database.withSession("first-primary")
      .prepare(
        "SELECT * FROM shared_recognition_recordings WHERE recording_id=? AND namespace=?",
      )
      .bind(id, this.namespace)
      .first<Recording>();
  }
  /** Capture immediately before the fresh recognition/coverage read. */
  async catalogRevision() {
    await this.db
      .prepare(
        "INSERT INTO shared_recognition_catalog_revision(namespace) VALUES(?) ON CONFLICT DO NOTHING",
      )
      .bind(this.namespace)
      .run();
    const row = await this.db
      .prepare(
        "SELECT revision FROM shared_recognition_catalog_revision WHERE namespace=?",
      )
      .bind(this.namespace)
      .first<{ revision: number }>();
    insist(row, "recognition_catalog_unavailable", 503);
    return row.revision;
  }
  /** Current verified publication/creator facts and a fresh original disposition
   * are required. The same transaction fences any intervening catalog change. */
  async enroll(input: VerifiedPublication, catalogRevision: number) {
    const p = verifiedPublication(input);
    integer(catalogRevision, 0, Number.MAX_SAFE_INTEGER - 1);
    insist(
      p.namespace === this.namespace,
      "recognition_namespace_mismatch",
      403,
    );
    const id = recordingId(p),
      aid = associationId(p),
      json = canonical(p),
      enrollmentToken = token();
    let reserved = false;
    try {
      const results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE shared_recognition_catalog_revision SET revision=revision+1,enrollment_token=?
        WHERE namespace=? AND revision=? AND NOT EXISTS(SELECT 1 FROM shared_recognition_original_gate g WHERE g.namespace=shared_recognition_catalog_revision.namespace AND g.reservation_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM shared_recognition_recordings
          WHERE namespace=? AND recording_id<>? AND state NOT IN ('ready','deleted'))`,
          )
          .bind(
            enrollmentToken,
            this.namespace,
            catalogRevision,
            this.namespace,
            id,
          ),
        this.db
          .prepare(
            `INSERT INTO shared_recognition_recordings
        (recording_id,namespace,creator_key,audio_sha256,audio_bytes,state)
        SELECT ?,?,?,?,?,'pending' WHERE EXISTS(SELECT 1 FROM shared_recognition_catalog_revision
          WHERE namespace=? AND enrollment_token=?)
        ON CONFLICT DO NOTHING`,
          )
          .bind(
            id,
            p.namespace,
            p.creatorKey,
            p.audioSha256,
            p.audioBytes,
            p.namespace,
            enrollmentToken,
          ),
        this.db
          .prepare(
            `INSERT INTO shared_recognition_publications
        (association_id,recording_id,namespace,community_id,post_id,publication_revision,publication_json,state)
        SELECT ?,?,?,?,?,?,?,'active' WHERE EXISTS(SELECT 1 FROM shared_recognition_catalog_revision
          WHERE namespace=? AND enrollment_token=?) ON CONFLICT DO NOTHING`,
          )
          .bind(
            aid,
            id,
            p.namespace,
            p.communityId,
            p.postId,
            p.publicationRevision,
            json,
            p.namespace,
            enrollmentToken,
          ),
        this.db
          .prepare(
            `UPDATE shared_recognition_publications SET state='withdrawn'
        WHERE namespace=? AND community_id=? AND post_id=? AND publication_revision<? AND state='active'
        AND EXISTS(SELECT 1 FROM shared_recognition_catalog_revision WHERE namespace=? AND enrollment_token=?)`,
          )
          .bind(
            p.namespace,
            p.communityId,
            p.postId,
            p.publicationRevision,
            p.namespace,
            enrollmentToken,
          ),
      ]);
      reserved = results[0]!.meta.changes === 1;
    } catch (error) {
      if (
        error instanceof Error &&
        /recognition_(recording|publication)_conflict/.test(error.message)
      )
        throw new CommunityError("recognition_publication_conflict", 409);
      throw error;
    }
    insist(reserved, "recognition_catalog_changed_or_incomplete", 409);
    const association = await this.association(aid, p.communityId);
    insist(
      association?.publication_json === json && association.recording_id === id,
      "recognition_publication_conflict",
      409,
    );
    return { recording: (await this.get(id))!, association };
  }
  /** A server-verified acoustic match can associate different encoded bytes
   * with an existing canonical recording without another catalog upload. */
  async associateMatched(
    input: VerifiedPublication,
    canonicalRecordingId: string,
    evidenceSha256: string,
  ) {
    const p = verifiedPublication(input),
      aid = associationId(p),
      json = canonical(p);
    bytes32(canonicalRecordingId);
    bytes32(evidenceSha256);
    insist(
      p.namespace === this.namespace,
      "recognition_namespace_mismatch",
      403,
    );
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO shared_recognition_publications
        (association_id,recording_id,namespace,community_id,post_id,publication_revision,publication_json,match_evidence_sha256,state)
        SELECT ?,r.recording_id,?,?,?,?,?,?,'active' FROM shared_recognition_recordings r
        WHERE r.recording_id=? AND r.namespace=? AND r.creator_key=? AND r.state='ready'
        ON CONFLICT DO NOTHING`,
        )
        .bind(
          aid,
          p.namespace,
          p.communityId,
          p.postId,
          p.publicationRevision,
          json,
          evidenceSha256,
          canonicalRecordingId,
          this.namespace,
          p.creatorKey,
        ),
      this.db
        .prepare(
          `UPDATE shared_recognition_publications SET state='withdrawn'
        WHERE namespace=? AND community_id=? AND post_id=? AND publication_revision<? AND state='active'
        AND EXISTS(SELECT 1 FROM shared_recognition_publications n WHERE n.association_id=? AND n.publication_json=?)`,
        )
        .bind(
          p.namespace,
          p.communityId,
          p.postId,
          p.publicationRevision,
          aid,
          json,
        ),
    ]);
    const association = await this.association(aid, p.communityId),
      r = await this.get(canonicalRecordingId);
    insist(
      association?.publication_json === json &&
        association.recording_id === canonicalRecordingId &&
        r,
      "recognition_match_binding_changed",
      409,
    );
    return { recording: r, association };
  }
  async association(id: string, communityId: string) {
    return this.db
      .prepare(
        `SELECT association_id,recording_id,publication_json,state
      FROM shared_recognition_publications WHERE association_id=? AND namespace=? AND community_id=?`,
      )
      .bind(id, this.namespace, communityId)
      .first<Association>();
  }
  /** Every status fence is the first query in a fresh primary-anchored session.
   * Reusing a request session could serve a replica at its older bookmark after
   * another request withdrew the association during asynchronous signing.
   * The single joined read also prevents a mixed association/recording state. */
  async status(id: string, communityId: string) {
    return this.database
      .withSession("first-primary")
      .prepare(
        `SELECT p.association_id,p.recording_id,p.publication_json,
      p.state AS association_state,r.state AS recording_state,r.audio_sha256 AS canonical_audio_sha256,
      c.revision AS catalog_revision FROM shared_recognition_publications p
      JOIN shared_recognition_recordings r ON r.recording_id=p.recording_id AND r.namespace=p.namespace
      JOIN shared_recognition_catalog_revision c ON c.namespace=p.namespace
      WHERE p.association_id=? AND p.namespace=? AND p.community_id=?`,
      )
      .bind(id, this.namespace, communityId)
      .first<CatalogStatusSnapshot>();
  }
  async active(id: string, source?: { communityId: string; postId: string }) {
    const row = await this.db
      .prepare(
        `SELECT publication_json FROM shared_recognition_publications
      WHERE recording_id=? AND namespace=? AND state='active'${source ? " AND community_id=? AND post_id=?" : ""}
      ORDER BY publication_revision DESC,association_id LIMIT 1`,
      )
      .bind(
        id,
        this.namespace,
        ...(source ? [source.communityId, source.postId] : []),
      )
      .first<{ publication_json: string }>();
    return row ? verifiedPublication(JSON.parse(row.publication_json)) : null;
  }

  /** Provisional ownership is separate from published associations. No fabricated
   * publication evidence is created merely to feed the enrollment worker. */
  async source(id: string): Promise<VerifiedPublication | AcceptedIntent | null> {
    const row = await this.database.withSession("first-primary").prepare(`
      SELECT publication_json AS source_json,'publication' AS kind FROM shared_recognition_publications
      WHERE recording_id=? AND namespace=? AND state='active'
      UNION ALL SELECT intent_json AS source_json,'intent' AS kind FROM shared_recognition_reservations
      WHERE recording_id=? AND namespace=? AND state IN ('enrollment_pending','ready','committing') LIMIT 1`)
      .bind(id,this.namespace,id,this.namespace).first<{source_json:string;kind:string}>();
    return row ? row.kind === "intent" ? acceptedIntent(JSON.parse(row.source_json)) : verifiedPublication(JSON.parse(row.source_json)) : null;
  }
  /** Server-verified withdrawal facts must match the enrolled revision exactly. */
  async withdraw(input: VerifiedPublication, withdrawalEvidenceSha256: string) {
    const p = verifiedPublication(input),
      aid = associationId(p);
    bytes32(withdrawalEvidenceSha256);
    insist(
      p.namespace === this.namespace,
      "recognition_namespace_mismatch",
      403,
    );
    const before = await this.association(aid, p.communityId);
    insist(
      before && before.publication_json === canonical(p),
      "recognition_withdrawal_conflict",
      409,
    );
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO shared_recognition_events(recording_id,kind,evidence_json,created_at)
        SELECT recording_id,'withdrawal',?,? FROM shared_recognition_publications
        WHERE association_id=? AND namespace=? AND state='active'`,
        )
        .bind(
          canonical({ associationId: aid, withdrawalEvidenceSha256 }),
          this.now(),
          aid,
          this.namespace,
        ),
      this.db
        .prepare(
          `UPDATE shared_recognition_publications SET state='withdrawn'
        WHERE association_id=? AND namespace=? AND publication_json=?`,
        )
        .bind(aid, this.namespace, canonical(p)),
    ]);
    return before.recording_id;
  }
  async claim(id: string, leaseMs = 60000) {
    insist(
      Number.isSafeInteger(leaseMs) && leaseMs >= 1000 && leaseMs <= 180000,
      "invalid_recognition_lease",
    );
    const now = this.now();
    return this.db
      .prepare(
        `UPDATE shared_recognition_recordings
      SET claim_token=?,lease_until=?,attempt=attempt+1
      WHERE recording_id=? AND namespace=? AND lease_until<=? AND state<>'deleted'
      AND (state NOT IN ('ready','failed') OR NOT EXISTS(SELECT 1 FROM shared_recognition_publications p
        WHERE p.recording_id=shared_recognition_recordings.recording_id AND p.state='active') AND NOT EXISTS(SELECT 1 FROM shared_recognition_reservations q WHERE q.recording_id=shared_recognition_recordings.recording_id AND q.state IN ('enrollment_pending','ready','committing'))) RETURNING *`,
      )
      .bind(token(), now + leaseMs, id, this.namespace, now)
      .first<Recording>();
  }
  async requireClaim(r: Recording) {
    const live = await this.get(r.recording_id);
    insist(
      live &&
        live.claim_token === r.claim_token &&
        live.attempt === r.attempt &&
        live.lease_until > this.now() &&
        live.state === r.state,
      "recognition_claim_lost",
      409,
    );
  }
  async release(r: Recording) {
    await this.db
      .prepare(
        `UPDATE shared_recognition_recordings SET claim_token=NULL,lease_until=0
      WHERE recording_id=? AND namespace=? AND claim_token=? AND attempt=?`,
      )
      .bind(r.recording_id, this.namespace, r.claim_token, r.attempt)
      .run();
  }
  async transition(
    r: Recording,
    state: RecordingState,
    evidence: unknown,
    file?: CatalogFile,
  ) {
    if (file) {
      insist(
        exactCatalogFile(r, file) &&
          (!r.provider_file_id ||
            (r.provider_file_id === file.fileId &&
              r.provider_match_id === file.matchId)),
        "recognition_catalog_identity_changed",
        409,
      );
    }
    const now = this.now(),
      condition = `recording_id=? AND namespace=? AND claim_token=? AND attempt=? AND lease_until>? AND state=?`,
      binds = [
        r.recording_id,
        this.namespace,
        r.claim_token,
        r.attempt,
        now,
        r.state,
      ];
    // The active-association predicate commits with the upload intent. A last
    // withdrawal cannot race an unclaimed read into permission for a new upload.
    const active =
      state === "upload_unknown"
        ? ` AND (EXISTS(SELECT 1 FROM shared_recognition_publications p
      WHERE p.recording_id=shared_recognition_recordings.recording_id AND p.state='active') OR EXISTS(SELECT 1 FROM shared_recognition_reservations q
      WHERE q.recording_id=shared_recognition_recordings.recording_id AND q.state IN ('enrollment_pending','ready','committing')))`
        : state === "deleting" || state === "deleted"
          ? ` AND NOT EXISTS(SELECT 1 FROM shared_recognition_publications p
      WHERE p.recording_id=shared_recognition_recordings.recording_id AND p.state='active') AND NOT EXISTS(SELECT 1 FROM shared_recognition_reservations q
      WHERE q.recording_id=shared_recognition_recordings.recording_id AND q.state IN ('enrollment_pending','ready','committing'))`
          : "";
    const results = await this.db.batch<Recording>([
      this.db
        .prepare(
          `INSERT INTO shared_recognition_events(recording_id,kind,evidence_json,created_at)
        SELECT recording_id,?,?,? FROM shared_recognition_recordings WHERE ${condition}${active}`,
        )
        .bind(state, canonical(evidence), now, ...binds),
      this.db
        .prepare(
          `UPDATE shared_recognition_recordings SET state=?,
        provider_file_id=COALESCE(?,provider_file_id),provider_match_id=COALESCE(?,provider_match_id)
        WHERE ${condition}${active} RETURNING *`,
        )
        .bind(state, file?.fileId ?? null, file?.matchId ?? null, ...binds),
    ]);
    insist(
      results[1]!.results.length === 1,
      "recognition_claim_or_association_changed",
      409,
    );
    // Use the exact CAS result. A separate read could observe a successor lease
    // after expiry and accidentally let this worker adopt another worker's claim.
    return results[1]!.results[0]!;
  }
  async matched(matchId: string) {
    return this.db
      .prepare(
        `SELECT r.* FROM shared_recognition_recordings r
      WHERE r.namespace=? AND r.provider_match_id=? AND r.state='ready'
      AND (EXISTS(SELECT 1 FROM shared_recognition_publications p WHERE p.recording_id=r.recording_id AND p.state='active') OR EXISTS(SELECT 1 FROM shared_recognition_reservations q WHERE q.recording_id=r.recording_id AND q.state IN ('enrollment_pending','ready','committing')))`,
      )
      .bind(this.namespace, matchId)
      .first<Recording>();
  }
  async verificationReceipt(r: Recording): Promise<unknown | null> {
    const row = await this.db
      .prepare(
        `SELECT evidence_json FROM shared_recognition_events
      WHERE recording_id=? AND kind='receipt:verify' AND event_id >
        COALESCE((SELECT max(event_id) FROM shared_recognition_events WHERE recording_id=? AND kind='verification_unknown'),0)
      ORDER BY event_id DESC LIMIT 1`,
      )
      .bind(r.recording_id, r.recording_id)
      .first<{ evidence_json: string }>();
    return row ? JSON.parse(row.evidence_json).receipt : null;
  }
  async receipt(r: Recording, kind: string, value: unknown) {
    const changed = await this.db
      .prepare(
        `INSERT INTO shared_recognition_events(recording_id,kind,evidence_json,created_at)
      SELECT recording_id,?,?,? FROM shared_recognition_recordings
      WHERE recording_id=? AND namespace=? AND claim_token=? AND attempt=?`,
      )
      .bind(
        `receipt:${kind}`,
        canonical({ attempt: r.attempt, receipt: value }),
        this.now(),
        r.recording_id,
        this.namespace,
        r.claim_token,
        r.attempt,
      )
      .run();
    insist(
      changed.meta.changes === 1,
      "recognition_receipt_claim_changed",
      409,
    );
  }
  async due(limit = 20) {
    insist(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      "invalid_recognition_batch",
    );
    const rows = await this.db
      .prepare(
        `SELECT recording_id FROM shared_recognition_recordings r
      WHERE namespace=? AND lease_until<=? AND state<>'deleted'
      AND (state NOT IN ('ready','failed') OR NOT EXISTS(SELECT 1 FROM shared_recognition_publications p
        WHERE p.recording_id=r.recording_id AND p.state='active') AND NOT EXISTS(SELECT 1 FROM shared_recognition_reservations q WHERE q.recording_id=r.recording_id AND q.state IN ('enrollment_pending','ready','committing'))) ORDER BY recording_id LIMIT ?`,
      )
      .bind(this.namespace, this.now(), limit)
      .all<{ recording_id: string }>();
    return rows.results.map((row) => row.recording_id);
  }
}
