import {
  STUDY_POLICY,
  STUDY_SCHEMA,
  StudyError,
  studyCheck,
  type StudyAttempt,
  type StudyLine,
  type StudyPrincipal,
  type StudySelection,
  type StudyAttemptLesson,
} from "./contracts.ts";
import type { AdmittedStudyGrader } from "./grader-revision.ts";

interface Row {
  attempt_id: string;
  line_json: string;
  started_at: number;
  completed_at: number | null;
  state: StudyAttempt["state"];
  audio_digest: string | null;
  grade_json: string | null;
  failure: string | null;
  policy: AdmittedStudyGrader;
  lesson_id: string | null;
  presentation_number: number | null;
  take_number: number | null;
  audio_duration_ms: number | null;
}
export const attemptView = (row: Row): StudyAttempt => ({
  schema: STUDY_SCHEMA,
  kind: "say-it-back",
  attemptId: row.attempt_id,
  line: JSON.parse(row.line_json),
  policy: row.policy,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  state: row.state,
  grade: row.grade_json === null ? null : JSON.parse(row.grade_json),
  failure: row.failure,
  lesson:
    row.lesson_id === null
      ? null
      : {
          lessonId: row.lesson_id,
          presentationNumber: row.presentation_number!,
          takeNumber: row.take_number!,
        },
  recordingDurationMs: row.audio_duration_ms,
  qualification: "not_evaluated",
});
export class StudyAttemptStore {
  readonly db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }
  async get(owner: StudyPrincipal, id: string): Promise<Row> {
    const row = await this.db
      .prepare(
        "SELECT * FROM study_attempts WHERE attempt_id=? AND account_id=? AND community_id=?",
      )
      .bind(id, owner.accountId, owner.communityId)
      .first<Row>();
    if (!row) throw new StudyError("study_attempt_not_found", 404);
    return row;
  }
  async list(owner: StudyPrincipal, line?: StudySelection) {
    let sql =
      "SELECT * FROM study_attempts WHERE account_id=? AND community_id=?";
    const args: (string | number)[] = [owner.accountId, owner.communityId];
    if (line) {
      for (const key of [
        "chainId",
        "postsContract",
        "postId",
        "lyricRevision",
        "lineId",
      ] as const) {
        sql += ` AND json_extract(line_json,'$.${key}')=?`;
        args.push(line[key]);
      }
    }
    const rows = await this.db
      .prepare(sql + " ORDER BY started_at DESC,rowid DESC LIMIT 50")
      .bind(...args)
      .all<Row>();
    return rows.results.map(attemptView);
  }
  async open(
    owner: StudyPrincipal,
    requestId: string,
    line: StudyLine,
    now: number,
    lesson: StudyAttemptLesson | null = null,
    policy: AdmittedStudyGrader = STUDY_POLICY,
  ) {
    // The owner-operated MVP has no application speech quota. The lesson
    // service bounds presentations/retries; conflicting requests reuse a row.
    await this.db
      .prepare(
        `INSERT INTO study_attempts(attempt_id,account_id,community_id,request_id,line_json,started_at,policy,lesson_id,presentation_number,take_number,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,'ready')
      ON CONFLICT(account_id,community_id,request_id) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        owner.accountId,
        owner.communityId,
        requestId,
        JSON.stringify(line),
        now,
        policy,
        lesson?.lessonId ?? null,
        lesson?.presentationNumber ?? null,
        lesson?.takeNumber ?? null,
      )
      .run();
    const row = await this.db
      .prepare(
        "SELECT * FROM study_attempts WHERE account_id=? AND community_id=? AND request_id=?",
      )
      .bind(owner.accountId, owner.communityId, requestId)
      .first<Row>();
    studyCheck(row, "study_attempt_unavailable", 503);
    studyCheck(
      row.policy === policy &&
        row.line_json === JSON.stringify(line) &&
        row.lesson_id === (lesson?.lessonId ?? null) &&
        row.presentation_number === (lesson?.presentationNumber ?? null) &&
        row.take_number === (lesson?.takeNumber ?? null),
      "study_request_conflict",
      409,
    );
    return attemptView(row);
  }
  async claim(
    owner: StudyPrincipal,
    id: string,
    digest: string,
    now: number,
    durationMs: number,
  ) {
    const row = await this.get(owner, id);
    studyCheck(
      row.audio_digest === null ||
        (row.audio_digest === digest && row.audio_duration_ms === durationMs),
      "study_audio_conflict",
      409,
    );
    if (row.state !== "ready") return false;
    studyCheck(row.started_at + 300000 >= now, "study_recording_expired", 409);
    const result = await this.db
      .prepare(
        `UPDATE study_attempts SET state='assessing',audio_digest=?,audio_duration_ms=?
        WHERE attempt_id=? AND account_id=? AND community_id=? AND state='ready'
        AND (lesson_id IS NULL OR EXISTS(SELECT 1 FROM study_lessons l
          WHERE l.lesson_id=study_attempts.lesson_id
          AND json_extract(l.state_json,'$.status')='active'
          AND json_extract(l.state_json,'$.currentAttemptId')=study_attempts.attempt_id
          AND json_extract(l.state_json,'$.expiresAt')>?))`,
      )
      .bind(digest, durationMs, id, owner.accountId, owner.communityId, now)
      .run();
    if (result.meta.changes !== 1) {
      studyCheck(
        (await this.get(owner, id)).audio_digest === digest &&
          (await this.get(owner, id)).audio_duration_ms === durationMs,
        "study_audio_conflict",
        409,
      );
    }
    return result.meta.changes === 1;
  }
  async expireReady(owner: StudyPrincipal, id: string, now: number) {
    await this.db
      .prepare(
        "UPDATE study_attempts SET state='unavailable',failure='study_recording_expired',completed_at=? WHERE attempt_id=? AND account_id=? AND community_id=? AND state='ready' AND started_at<?",
      )
      .bind(now, id, owner.accountId, owner.communityId, now - 300000)
      .run();
  }
  async finish(
    owner: StudyPrincipal,
    id: string,
    state: "assessed" | "unavailable" | "uncertain",
    grade: StudyAttempt["grade"],
    failure: string | null,
    now: number,
    expectedState: "assessing" | "uncertain" = "assessing",
  ) {
    await this.db
      .prepare(
        `UPDATE study_attempts SET state=?,grade_json=?,failure=?,completed_at=?
        WHERE attempt_id=? AND account_id=? AND community_id=? AND state=?
        AND (lesson_id IS NULL OR EXISTS(SELECT 1 FROM study_lessons l
          WHERE l.lesson_id=study_attempts.lesson_id
          AND json_extract(l.state_json,'$.status')='active'
          AND json_extract(l.state_json,'$.currentAttemptId')=study_attempts.attempt_id
          AND json_extract(l.state_json,'$.expiresAt')>?))`,
      )
      .bind(
        state,
        grade === null ? null : JSON.stringify(grade),
        failure,
        now,
        id,
        owner.accountId,
        owner.communityId,
        expectedState,
        now,
      )
      .run();
    return attemptView(await this.get(owner, id));
  }
}
