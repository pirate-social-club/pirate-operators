import { hashJson, insist, token } from "../community/common.ts";
import {
  DANCE_VERSION,
  type DanceCapture,
  type DanceFence,
  type DanceReceipt,
  type DanceReview,
  type SqlValue,
} from "./contracts.ts";
import { validateFence } from "./validation.ts";

/** Database time evaluated by the winning mutation, never a browser timestamp. */
export const DANCE_DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
export class DanceStore {
  readonly db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }
  stmt(sql: string, ...values: SqlValue[]) {
    return this.db.prepare(sql).bind(...values);
  }
  async now() {
    const row = await this.stmt(`SELECT ${DANCE_DB_NOW} AS n`).first<{
      n: number;
    }>();
    insist(row && Number.isSafeInteger(row.n), "dance_clock_unavailable", 503);
    return row.n;
  }
  /** Fences are asserted inside the SAME batch as effects, not checked booleans. */
  async atomic(fences: DanceFence[], statements: D1PreparedStatement[]) {
    insist(fences.length > 0, "dance_fence_unavailable", 503);
    const ids = fences.map(() => token());
    try {
      await this.db.batch([
        ...fences.map((f, i) => {
          validateFence(f);
          return this.stmt(
            `INSERT INTO dance_transaction_guards(guard_id,valid)
            SELECT ?,CASE WHEN (${f.sql}) THEN 1 ELSE 0 END`,
            ids[i],
            ...f.values,
          );
        }),
        ...statements,
        this.stmt("DELETE FROM dance_transaction_guards"),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("CHECK constraint failed: valid = 1")
      )
        insist(false, "dance_fence_changed", 409);
      // Unknown transport/commit errors retain original cause. Caller retries same command.
      throw error;
    }
  }
  changed(): D1PreparedStatement {
    return this.stmt(
      `INSERT INTO dance_transaction_guards(guard_id,valid)
      VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)`,
      token(),
    );
  }
  async capture(id: string) {
    const row = await this.stmt(
      "SELECT capture_json FROM dance_captures WHERE capture_id=?",
      id,
    ).first<{ capture_json: string }>();
    insist(row, "dance_not_found", 404);
    return JSON.parse(row.capture_json) as DanceCapture;
  }
  async review(id: string): Promise<DanceReview> {
    const row = await this.stmt(
      `SELECT r.*,c.capture_json,v.verdict_json FROM dance_reviews r
      JOIN dance_captures c ON c.capture_id=r.review_id
      LEFT JOIN dance_verdicts v ON v.review_id=r.review_id WHERE r.review_id=?`,
      id,
    ).first<{
      review_id: string;
      revision: number;
      capture_json: string;
      media_id: string;
      media_revision: number;
      recording_digest: string;
      uploaded_at_ms: number;
      submitted_at_ms: number;
      deadline_ms: number;
      state: DanceReview["state"];
      verdict_json: string | null;
    }>();
    insist(row, "dance_not_found", 404);
    return {
      version: DANCE_VERSION,
      reviewId: row.review_id,
      revision: row.revision,
      capture: JSON.parse(row.capture_json),
      mediaId: row.media_id,
      mediaRevision: row.media_revision,
      recordingSha256: row.recording_digest,
      uploadedAtMs: row.uploaded_at_ms,
      submittedAtMs: row.submitted_at_ms,
      reviewDeadlineMs: row.deadline_ms,
      state: row.state,
      verdict: row.verdict_json ? JSON.parse(row.verdict_json) : null,
    };
  }
  async receipt(
    community: string,
    actor: string,
    command: string,
    requestHash: string,
  ) {
    const row = await this.stmt(
      `SELECT request_hash,receipt_json FROM dance_receipts
      WHERE community_id=? AND actor_id=? AND command_id=?`,
      community,
      actor,
      command,
    ).first<{ request_hash: string; receipt_json: string }>();
    if (!row) return null;
    insist(row.request_hash === requestHash, "dance_idempotency_conflict", 409);
    return JSON.parse(row.receipt_json) as DanceReceipt;
  }
  saveReceipt(
    community: string,
    actor: string,
    command: string,
    hash: string,
    review: string,
  ) {
    return this.stmt(
      `INSERT INTO dance_receipts
      SELECT ?,?,?,?,json_object('version',?,'commandId',?,'reviewId',r.review_id,
        'revision',r.revision,'state',r.state,'verdict',json(v.verdict_json))
      FROM dance_reviews r LEFT JOIN dance_verdicts v ON v.review_id=r.review_id
      WHERE r.review_id=?`,
      community,
      actor,
      command,
      hash,
      DANCE_VERSION,
      command,
      review,
    );
  }
  static request(operation: string, body: unknown) {
    return hashJson({ version: DANCE_VERSION, operation, body });
  }
}
