import {
  StudyError,
  studyCheck,
  type StudyPrincipal,
  type StudyAttempt,
} from "./contracts.ts";
import {
  STUDY_QUEUE_POLICY,
  type LessonState,
  type StudySong,
} from "./lesson.ts";
import type { StudyLinePractice } from "./line-selection.ts";
export interface LessonRow {
  lesson_id: string;
  revision: number;
  state_json: string;
  song_json: string;
  history_deleted_at: number | null;
}
export class StudyLessonStore {
  readonly db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }
  async row(owner: StudyPrincipal, id: string) {
    const row = await this.db
      .prepare(
        "SELECT * FROM study_lessons WHERE lesson_id=? AND account_id=? AND community_id=?",
      )
      .bind(id, owner.accountId, owner.communityId)
      .first<LessonRow>();
    if (!row) throw new StudyError("study_lesson_not_found", 404);
    return row;
  }
  state(row: LessonRow): LessonState {
    studyCheck(row.history_deleted_at == null, "study_history_expired", 410);
    const state: LessonState = JSON.parse(row.state_json);
    studyCheck(
      state.policy === STUDY_QUEUE_POLICY,
      "study_lesson_policy_unavailable",
      503,
    );
    return state;
  }
  async latest(owner: StudyPrincipal, song: StudySong) {
    return this.db
      .prepare(
        "SELECT * FROM study_lessons WHERE account_id=? AND community_id=? AND song_json=? AND history_deleted_at IS NULL ORDER BY started_at DESC,rowid DESC LIMIT 1",
      )
      .bind(owner.accountId, owner.communityId, JSON.stringify(song))
      .first<LessonRow>();
  }
  async byRequest(owner: StudyPrincipal, requestId: string) {
    return this.db
      .prepare(
        "SELECT * FROM study_lessons WHERE account_id=? AND community_id=? AND request_id=?",
      )
      .bind(owner.accountId, owner.communityId, requestId)
      .first<LessonRow>();
  }
  async practice(owner: StudyPrincipal, song: StudySong) {
    // Count immutable assessed attempts, including a saved grade whose queue
    // reconciliation has not run yet. Replays and ungraded failures add no row.
    const rows = await this.db
      .prepare(
        `
      SELECT json_extract(a.line_json,'$.text') AS text,
             json_extract(a.line_json,'$.language') AS language,
             count(*) AS presentations, max(a.completed_at) AS lastPractisedAt
        FROM study_attempts a
        JOIN study_lessons l ON l.lesson_id=a.lesson_id
         AND l.account_id=a.account_id AND l.community_id=a.community_id
       WHERE a.account_id=? AND a.community_id=? AND a.state='assessed'
         AND json_extract(l.song_json,'$.chainId')=?
         AND json_extract(l.song_json,'$.postsContract')=?
         AND json_extract(l.song_json,'$.postId')=?
       GROUP BY json_extract(a.line_json,'$.text'),
                json_extract(a.line_json,'$.language')
    `,
      )
      .bind(
        owner.accountId,
        owner.communityId,
        song.chainId,
        song.postsContract,
        song.postId,
      )
      .all<StudyLinePractice>();
    return rows.results;
  }
  async create(owner: StudyPrincipal, requestId: string, state: LessonState) {
    await this.db
      .prepare(
        "INSERT INTO study_lessons(lesson_id,account_id,community_id,request_id,song_json,state_json,started_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,community_id,request_id) DO NOTHING",
      )
      .bind(
        crypto.randomUUID(),
        owner.accountId,
        owner.communityId,
        requestId,
        JSON.stringify(state.song),
        JSON.stringify(state),
        state.startedAt,
      )
      .run();
    const row = await this.byRequest(owner, requestId);
    studyCheck(
      row && row.song_json === JSON.stringify(state.song),
      "study_request_conflict",
      409,
    );
    return row;
  }
  async update(owner: StudyPrincipal, row: LessonRow, state: LessonState) {
    const result = await this.db
      .prepare(
        "UPDATE study_lessons SET state_json=?,revision=revision+1 WHERE lesson_id=? AND account_id=? AND community_id=? AND revision=?",
      )
      .bind(
        JSON.stringify(state),
        row.lesson_id,
        owner.accountId,
        owner.communityId,
        row.revision,
      )
      .run();
    return result.meta.changes === 1;
  }
  async submittedLines(owner: StudyPrincipal, id: string) {
    const rows = await this.db
      .prepare(
        "SELECT DISTINCT json_extract(line_json,'$.lineId') AS line_id FROM study_attempts WHERE lesson_id=? AND account_id=? AND community_id=? AND audio_digest IS NOT NULL",
      )
      .bind(id, owner.accountId, owner.communityId)
      .all<{ line_id: string }>();
    return new Set(rows.results.map((row) => row.line_id));
  }
  async close(
    owner: StudyPrincipal,
    row: LessonRow,
    state: LessonState,
    current: StudyAttempt | null,
  ) {
    // The current attempt's state is a second CAS input. If claim/finish won,
    // reread it before freezing absence or grade. The batch seals pending takes
    // only after a successful closure (or an already terminal competing close).
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE study_lessons SET state_json=?,revision=revision+1
        WHERE lesson_id=? AND account_id=? AND community_id=? AND revision=?
        AND json_extract(state_json,'$.status')='active'
        AND (? IS NULL OR EXISTS(SELECT 1 FROM study_attempts
          WHERE attempt_id=? AND lesson_id=study_lessons.lesson_id AND state=?))`,
        )
        .bind(
          JSON.stringify(state),
          row.lesson_id,
          owner.accountId,
          owner.communityId,
          row.revision,
          current?.attemptId ?? null,
          current?.attemptId ?? null,
          current?.state ?? null,
        ),
      this.db
        .prepare(
          `UPDATE study_attempts SET
        failure='study_lesson_closed',completed_at=?,
        state=CASE WHEN state='ready' THEN 'unavailable' ELSE 'uncertain' END
        WHERE lesson_id=? AND account_id=? AND community_id=?
        AND state IN ('ready','assessing')
        AND EXISTS(SELECT 1 FROM study_lessons WHERE lesson_id=study_attempts.lesson_id
          AND json_extract(state_json,'$.status')!='active')`,
        )
        .bind(
          state.completedAt,
          row.lesson_id,
          owner.accountId,
          owner.communityId,
        ),
    ]);
    return result[0].meta.changes === 1;
  }
}
