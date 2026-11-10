// Freeze validated public facts in D1 before any external publication request.
import { canonical, digest } from "../packages/protocol/index.ts";
import {
  studyExercisesHash,
  unpackStudyOutcomes,
} from "../packages/protocol/learning-results-v3.ts";
import {
  studyCheck,
  type StudyPrincipal,
} from "../packages/study/contracts.ts";
import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import { terminalStudyFacts } from "../packages/study/result-adapter.ts";
import type { StudyTerminalFacts } from "../packages/study/terminal-facts.ts";
import type { StudyPublicationReceipt } from "../packages/study/publication.ts";
import type { LyricManifest } from "../packages/community/lyric-manifest.ts";
import type { StudyBinding } from "./study-operator.ts";
import { erasedStudyReceipt } from "./study-private-history.ts";

export interface StudyOutboxRow {
  state: "bound" | StudyPublicationReceipt["state"];
  source_json: string;
  binding_json: string;
  terminal_json: string | null;
  receipt_json: string | null;
  updated_at: number;
}
export async function studyOutboxRow(
  db: D1Database,
  owner: StudyPrincipal,
  id: string,
) {
  await new StudyLessonStore(db).row(owner, id);
  return db
    .prepare(
      "SELECT state,source_json,binding_json,terminal_json,receipt_json,updated_at FROM study_publications WHERE lesson_id=? AND account_id=? AND community_id=?",
    )
    .bind(id, owner.accountId, owner.communityId)
    .first<StudyOutboxRow>();
}

export async function freezeStudyOutbox(
  db: D1Database,
  owner: StudyPrincipal,
  id: string,
) {
  const row = await studyOutboxRow(db, owner, id);
  if (
    !row ||
    row.terminal_json ||
    erasedStudyReceipt(row.receipt_json ? JSON.parse(row.receipt_json) : null)
  )
    return row;
  const lessons = new StudyLessonStore(db),
    lesson = await lessons.row(owner, id),
    state = lessons.state(lesson);
  if (state.status === "active") return null;
  const source = JSON.parse(row.source_json) as LyricManifest;
  const terminal: StudyTerminalFacts = terminalStudyFacts({
    lessonId: id,
    state,
    source,
  });
  const binding = JSON.parse(row.binding_json) as StudyBinding;
  const ordinals = unpackStudyOutcomes(
    terminal.outcomes,
    state.items.length,
  ).map((item) => item.sourceOrdinal);
  // V3 lessons stay inside their enrollment. A V4 lesson's sign-in has a
  // start and no end; withdrawal is re-read on chain before dispatch.
  const granted = binding.authorization
    ? binding.target.version === 4 &&
      binding.authorization.target.version === 4 &&
      binding.authorization.target.chainId === binding.target.chainId &&
      binding.authorization.target.contract.toLowerCase() ===
        binding.target.contract.toLowerCase() &&
      Math.floor(terminal.startedAt / 1000) >= binding.authorization.issuedAt
    : binding.target.version === 3 &&
      !!(binding.enrollment.activities! & 2) &&
      Math.floor(terminal.startedAt / 1000) >= binding.enrollment.issuedAt &&
      Math.floor(terminal.completedAt / 1000) < binding.enrollment.expiresAt;
  studyCheck(
    granted &&
      binding.offerHash === digest(binding.offer) &&
      binding.exercisesHash === studyExercisesHash(ordinals) &&
      canonical(
        binding.offer.exercises.map(({ ordinal, lineId, language }) => ({
          ordinal,
          lineId,
          language,
        })),
      ) ===
        canonical(
          ordinals.map((ordinal) => ({
            ordinal,
            lineId: source.lines[ordinal - 1].lineId,
            language: source.language,
          })),
        ) &&
      digest(source) === binding.offer.sourceDigest &&
      source.communityId === owner.communityId &&
      terminal.startedAt === binding.offer.startedAt &&
      terminal.expiresAt === binding.offer.expiresAt,
    "study_terminal_binding_changed",
    409,
  );
  await db
    .prepare(
      `UPDATE study_publications SET terminal_json=?
    WHERE lesson_id=? AND account_id=? AND community_id=? AND terminal_json IS NULL
    AND EXISTS(SELECT 1 FROM study_lessons WHERE lesson_id=study_publications.lesson_id
      AND revision=? AND history_deleted_at IS NULL)`,
    )
    .bind(
      JSON.stringify(terminal),
      id,
      owner.accountId,
      owner.communityId,
      lesson.revision,
    )
    .run();
  const saved = await studyOutboxRow(db, owner, id);
  studyCheck(
    saved?.terminal_json === JSON.stringify(terminal),
    "study_terminal_changed",
    409,
  );
  return saved;
}
