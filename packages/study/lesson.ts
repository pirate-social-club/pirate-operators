// Queue facts adopted from api-next a5c63b8 study-shared-lesson-engine.ts and
// study-v2-repository.ts. See the pinned rules and hashes in the source handoff.
import {
  selection,
  selectionOf,
  studyCheck,
  validateStudyLine,
  type StudyAttempt,
  type StudyLine,
  type StudySelection,
} from "./contracts.ts";
export type StudySong = Omit<StudySelection, "lineId">;
export const STUDY_LESSON_SCHEMA = "pirate.study.lesson/1" as const;
export const STUDY_QUEUE_POLICY = "pirate.study.lesson-queue/1" as const;
export const studyPresentationCap = (total: number) => Math.min(20, 3 * total);
export const songOf = (line: StudySelection): StudySong => ({
  chainId: line.chainId,
  postsContract: line.postsContract,
  communityId: line.communityId,
  postId: line.postId,
  lyricRevision: line.lyricRevision,
});
export function studySong(input: unknown): StudySong {
  studyCheck(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "invalid_study_song",
  );
  const parsed = selection({ ...input, lineId: `0x${"1".repeat(64)}` });
  studyCheck(Object.keys(input).length === 5, "invalid_study_song");
  return songOf(parsed);
}
export interface LessonItem {
  line: StudyLine;
  presentations: number;
  lastQueueOrdinal: number | null;
  mastered: boolean;
  resolved: boolean;
  firstPassOutcome: "correct" | "incorrect" | null;
}
export interface LessonState {
  policy: typeof STUDY_QUEUE_POLICY;
  song: StudySong;
  items: LessonItem[];
  startedAt: number;
  completedAt: number | null;
  status: "active" | "completed";
  completionReason: "all_resolved" | "presentation_budget" | null;
  presentationCount: number;
  currentIndex: number | null;
  currentAttemptId: string | null;
  lastAttemptId: string | null;
  takeNumber: number;
}
export interface StudyLesson {
  schema: typeof STUDY_LESSON_SCHEMA;
  kind: "say-it-back";
  lessonId: string;
  song: StudySong;
  startedAt: number;
  completedAt: number | null;
  status: LessonState["status"];
  completionReason: LessonState["completionReason"];
  current: {
    line: StudyLine;
    presentationNumber: number;
    takeNumber: number;
    attempt: StudyAttempt | null;
  } | null;
  lastAttempt: StudyAttempt | null;
  progress: {
    total: number;
    resolved: number;
    mastered: number;
    presentations: number;
    presentationCap: number;
    firstPassGraded: number;
    firstPassCorrect: number;
  };
  qualification: "not_evaluated";
}
export interface StudyLessonSubmission {
  attempt: StudyAttempt;
  lesson: StudyLesson;
}
export function newLesson(
  song: StudySong,
  lines: StudyLine[],
  now: number,
): LessonState {
  studyCheck(
    lines.length >= 4 &&
      lines.length <= 10 &&
      new Set(lines.map((l) => l.lineId)).size === lines.length,
    "insufficient_study_lines",
    409,
  );
  const validated = lines.map((line) => {
    const item = validateStudyLine(line, selection(selectionOf(line)));
    studyCheck(
      JSON.stringify(songOf(item)) === JSON.stringify(song),
      "study_reference_mismatch",
      409,
    );
    return item;
  });
  studyCheck(
    new Set(validated.map((l) => l.manifestDigest)).size === 1,
    "study_manifest_mismatch",
    409,
  );
  return {
    policy: STUDY_QUEUE_POLICY,
    song,
    items: validated.map((line) => ({
      line,
      presentations: 0,
      lastQueueOrdinal: null,
      mastered: false,
      resolved: false,
      firstPassOutcome: null,
    })),
    startedAt: now,
    completedAt: null,
    status: "active",
    completionReason: null,
    presentationCount: 0,
    currentIndex: 0,
    currentAttemptId: null,
    lastAttemptId: null,
    takeNumber: 1,
  };
}
export function consumeLessonGrade(
  state: LessonState,
  attempt: StudyAttempt,
  now: number,
): LessonState {
  studyCheck(
    state.status === "active" &&
      state.currentIndex !== null &&
      state.currentAttemptId === attempt.attemptId,
    "study_lesson_changed",
    409,
  );
  studyCheck(
    attempt.state === "assessed" && attempt.grade !== null,
    "study_grade_required",
    409,
  );
  const next: LessonState = structuredClone(state),
    item = next.items[next.currentIndex!];
  const correct = attempt.grade.correct;
  if (item.presentations === 0)
    item.firstPassOutcome = correct ? "correct" : "incorrect";
  item.presentations++;
  item.lastQueueOrdinal = state.presentationCount;
  item.mastered = correct;
  item.resolved = correct || item.presentations >= 3;
  next.presentationCount++;
  next.currentAttemptId = null;
  next.lastAttemptId = attempt.attemptId;
  next.takeNumber = 1;
  const unresolved = next.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.resolved);
  if (
    unresolved.length === 0 ||
    next.presentationCount >= studyPresentationCap(next.items.length)
  ) {
    next.status = "completed";
    next.completedAt = now;
    next.currentIndex = null;
    next.completionReason =
      unresolved.length === 0 ? "all_resolved" : "presentation_budget";
  } else {
    unresolved.sort(
      (a, b) =>
        Number(a.item.presentations > 0) - Number(b.item.presentations > 0) ||
        (a.item.lastQueueOrdinal ?? -1) - (b.item.lastQueueOrdinal ?? -1) ||
        a.index - b.index,
    );
    next.currentIndex = unresolved[0].index;
  }
  return next;
}
