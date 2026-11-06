// Private export reads one D1 transaction and never calls the operator/provider.
import { attemptView } from "../packages/study/attempt-store.ts";
import {
  studyCheck,
  type StudyPrincipal,
} from "../packages/study/contracts.ts";
import {
  STUDY_MAX_TAKES,
  studyPresentationCap,
  type LessonState,
} from "../packages/study/lesson.ts";

export const STUDY_HISTORY_EXPORT_WINDOW_MS = 30 * 86400 * 1000;
interface LessonRow {
  lesson_id: string;
  revision: number;
  state_json: string;
  history_deleted_at: number | null;
}
type AttemptRow = Parameters<typeof attemptView>[0];

export async function studyPrivateHistory(
  db: D1Database,
  owner: StudyPrincipal,
  id: string,
  now = Date.now,
) {
  const rows = await db.batch([
    db
      .prepare(
        "SELECT lesson_id,revision,state_json,history_deleted_at FROM study_lessons WHERE lesson_id=? AND account_id=? AND community_id=?",
      )
      .bind(id, owner.accountId, owner.communityId),
    // A lesson allows at most 20 graded presentations with three takes each.
    // Unlike the general recent-attempt list, an export must not truncate at 50.
    db
      .prepare(
        "SELECT * FROM study_attempts WHERE lesson_id=? AND account_id=? AND community_id=? ORDER BY started_at,attempt_id LIMIT 61",
      )
      .bind(id, owner.accountId, owner.communityId),
    db
      .prepare(
        "SELECT state,receipt_json FROM study_publications WHERE lesson_id=? AND account_id=? AND community_id=?",
      )
      .bind(id, owner.accountId, owner.communityId),
  ]);
  const lesson = rows[0].results[0] as unknown as LessonRow | undefined;
  studyCheck(lesson, "study_lesson_not_found", 404);
  studyCheck(lesson.history_deleted_at == null, "study_history_expired", 410);
  const state = JSON.parse(lesson.state_json) as LessonState;
  const completedAt = state.completedAt ?? state.expiresAt;
  studyCheck(
    Number.isSafeInteger(completedAt) && completedAt >= state.startedAt,
    "study_history_unavailable",
    503,
  );
  const exportAvailableUntil = completedAt + STUDY_HISTORY_EXPORT_WINDOW_MS;
  const exportedAt = now();
  studyCheck(exportedAt < exportAvailableUntil, "study_history_expired", 410);
  studyCheck(
    rows[1].results.length <=
      STUDY_MAX_TAKES * studyPresentationCap(state.items.length),
    "study_history_too_large",
    503,
  );
  const publication = rows[2].results[0] as
    | { state: string; receipt_json: string | null }
    | undefined;
  return {
    schema: "pirate.study-private-history/1",
    activity: "study",
    exportedAt,
    exportAvailableUntil,
    communityId: owner.communityId,
    lesson: { lessonId: id, revision: lesson.revision, state },
    attempts: rows[1].results.map((row) =>
      attemptView(row as unknown as AttemptRow),
    ),
    publication: publication
      ? {
          state: publication.state,
          receipt: publication.receipt_json
            ? JSON.parse(publication.receipt_json)
            : null,
        }
      : null,
    limitations: [
      "This is an interim operator-held private history copy, not an encrypted learner vault.",
      "Recognized words are speech-recognition evidence, not a direct pronunciation measurement.",
      "This private export does not create or change an official grade or reward.",
    ],
  };
}
