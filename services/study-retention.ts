// Scheduled deletion has no operator/provider dependency, including when
// practice is disabled. Public recovery facts and replay tombstones remain.
import {
  studyCheck,
  type StudyPrincipal,
} from "../packages/study/contracts.ts";
import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import { STUDY_HISTORY_EXPORT_WINDOW_MS } from "./study-history.ts";
import {
  makeStudyLessonService,
  STUDY_CLOSE_BOUND_SQL,
  studyCloseBoundBinds,
} from "./study-lessons.ts";
import { makeStudyService } from "./study-spoken.ts";
import { freezeStudyOutbox } from "./study-outbox.ts";
import { erasePrivateStudyOutbox } from "./study-private-history.ts";

export async function deleteExpiredStudyHistory(
  db: D1Database,
  communityId: string,
  now = Date.now,
  limit = 20,
) {
  studyCheck(
    Number.isInteger(limit) && limit > 0 && limit <= 100,
    "invalid_study_scan_limit",
  );
  const at = now(),
    unavailable = async (): Promise<never> => {
      throw Error("study_lesson_not_bound");
    };
  studyCheck(
    /^0x[0-9a-f]{64}$/.test(communityId) && Number.isSafeInteger(at) && at >= 0,
    "invalid_study_retention_scope",
  );
  const attempts = makeStudyService({
    db,
    now: () => at,
    resolveLine: unavailable,
    transcriber: { providerRetention: "stored", transcribe: unavailable },
  });
  const store = new StudyLessonStore(db);
  const lessons = makeStudyLessonService({
    db,
    now: () => at,
    attempts,
    consentExpiry: (owner, id) => store.consentExpiry(owner, id),
    resolveLines: unavailable,
  });
  const rows = await db
    .prepare(
      `SELECT l.lesson_id,l.account_id,l.community_id,
      COALESCE(json_extract(l.state_json,'$.completedAt'),${STUDY_CLOSE_BOUND_SQL}) AS due
    FROM study_lessons l LEFT JOIN study_publications p ON p.lesson_id=l.lesson_id
    WHERE l.community_id=? AND l.history_deleted_at IS NULL AND due<=?
    ORDER BY l.history_cleanup_attempts,due,l.lesson_id LIMIT ?`,
    )
    .bind(
      ...studyCloseBoundBinds,
      communityId,
      at - STUDY_HISTORY_EXPORT_WINDOW_MS,
      limit,
    )
    .all<{ lesson_id: string; account_id: string; community_id: string }>();
  const erase = async (row: (typeof rows.results)[number]) => {
    const owner: StudyPrincipal = {
      accountId: row.account_id,
      communityId: row.community_id,
    };
    // Consume an already saved grade before closing an old unattended lesson
    // at its close bound: a legacy deadline or a new lesson's consent end.
    // No recover/transcribe port is supplied, so uncertain dispatch stays so.
    await lessons.get(owner, row.lesson_id);
    await freezeStudyOutbox(db, owner, row.lesson_id);
    const saved = await store.row(owner, row.lesson_id),
      state = store.state(saved);
    if (
      state.status === "active" ||
      state.completedAt! + STUDY_HISTORY_EXPORT_WINDOW_MS > at
    )
      return 0;
    const result = await db.batch([
      db
        .prepare(
          `UPDATE study_lessons SET state_json='{}',history_deleted_at=?,revision=revision+1,
          song_json=CASE WHEN NOT EXISTS(SELECT 1 FROM study_publications WHERE lesson_id=study_lessons.lesson_id) THEN '{}' ELSE song_json END,
          started_at=CASE WHEN NOT EXISTS(SELECT 1 FROM study_publications WHERE lesson_id=study_lessons.lesson_id) THEN 0 ELSE started_at END
        WHERE lesson_id=? AND account_id=? AND community_id=? AND revision=? AND history_deleted_at IS NULL
        AND json_extract(state_json,'$.status')!='active'
        AND (NOT EXISTS(SELECT 1 FROM study_publications WHERE lesson_id=study_lessons.lesson_id)
          OR EXISTS(SELECT 1 FROM study_publications WHERE lesson_id=study_lessons.lesson_id AND terminal_json IS NOT NULL))`,
        )
        .bind(
          at,
          row.lesson_id,
          owner.accountId,
          owner.communityId,
          saved.revision,
        ),
      db
        .prepare(
          `DELETE FROM study_attempts WHERE lesson_id=? AND account_id=? AND community_id=?
        AND EXISTS(SELECT 1 FROM study_lessons WHERE lesson_id=study_attempts.lesson_id AND history_deleted_at=?)`,
        )
        .bind(row.lesson_id, owner.accountId, owner.communityId, at),
    ]);
    if (result[0].meta.changes)
      await erasePrivateStudyOutbox(db, owner, row.lesson_id);
    return result[0].meta.changes;
  };
  let deleted = 0;
  const failures: unknown[] = [];
  for (const row of rows.results) {
    try {
      // Retry bookkeeping is separate from queue revision and deletion state.
      // Fewest-attempted first advances beyond even a full batch of bad rows.
      const claimed = await db
        .prepare(
          `UPDATE study_lessons
        SET history_cleanup_attempts=history_cleanup_attempts+1
        WHERE lesson_id=? AND account_id=? AND community_id=? AND history_deleted_at IS NULL`,
        )
        .bind(row.lesson_id, row.account_id, row.community_id)
        .run();
      if (!claimed.meta.changes) continue;
      deleted += await erase(row);
    } catch (error) {
      failures.push(error);
    }
  }
  // Component-only attempts have no lesson/outbox to retain.
  await db
    .prepare(
      `DELETE FROM study_attempts WHERE attempt_id IN
    (SELECT attempt_id FROM study_attempts WHERE community_id=? AND lesson_id IS NULL
      AND COALESCE(completed_at,started_at)<=? ORDER BY started_at,attempt_id LIMIT ?)`,
    )
    .bind(communityId, at - STUDY_HISTORY_EXPORT_WINDOW_MS, limit)
    .run();
  // Report failures after allowing the other bounded rows to make progress.
  if (failures.length) throw failures[0];
  return deleted;
}
