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
/**
 * Study has no learner time limit (workspace_owner ruling, 2026-11-08). New
 * lessons store this value in `expiresAt`, which keeps the stored and offered
 * format and makes every deadline comparison false. Background retention is a
 * separate rule and does not use this field.
 */
export const STUDY_LESSON_NO_DEADLINE = Number.MAX_SAFE_INTEGER;
/**
 * Lessons started before the time limit was removed keep their one-hour
 * deadline. They still expire, recover and are erased exactly as before.
 */
export const STUDY_LESSON_LIFETIME_MS = 60 * 60 * 1000;
export const studyLessonHasDeadline = (state: { expiresAt: number }) =>
  state.expiresAt !== STUDY_LESSON_NO_DEADLINE;
/**
 * The longest a new lesson stays open. A draft that never bound consent closes
 * after this; so does a bound lesson whose consent would outlast it. Consent the
 * application requests lasts thirty days from before the lesson starts, so for
 * those lessons the consent end always comes first.
 */
export const STUDY_OPEN_LESSON_MAX_MS = 30 * 86400 * 1000;
export interface StudyCloseBound {
  at: number;
  status: "abandoned" | "expired";
  reason: "deadline" | "consent_ended" | "never_bound" | "open_limit";
}
/**
 * When an open lesson stops being able to continue. A legacy lesson stops at
 * its deadline. A new lesson stops at the earlier of the end of the consent it
 * was bound to, because the operator refuses speech after that and a result
 * completed outside that consent cannot be frozen, published or erased, and
 * thirty days after it started, so a consent with a distant end date cannot
 * keep private data indefinitely. The consent bound is its last millisecond.
 * A V4 lesson, bound to a sign-in that lasts until withdrawn, passes
 * +Infinity and always closes at the open limit.
 */
export function studyCloseBound(
  state: Pick<LessonState, "startedAt" | "expiresAt">,
  consentExpiresAtS: number | null,
): StudyCloseBound {
  if (studyLessonHasDeadline(state))
    return { at: state.expiresAt, status: "expired", reason: "deadline" };
  const limit = state.startedAt + STUDY_OPEN_LESSON_MAX_MS;
  if (consentExpiresAtS === null)
    return { at: limit, status: "abandoned", reason: "never_bound" };
  // A V4 lesson's sign-in permission has no end: +Infinity, so its bound is
  // the open limit.
  studyCheck(
    consentExpiresAtS === Infinity ||
      (Number.isFinite(consentExpiresAtS) && consentExpiresAtS > 0),
    "study_lesson_binding_invalid",
    503,
  );
  const consentEnd = consentExpiresAtS * 1000 - 1;
  return consentEnd < limit
    ? {
        at: Math.max(state.startedAt, consentEnd),
        status: "abandoned",
        reason: "consent_ended",
      }
    : { at: limit, status: "abandoned", reason: "open_limit" };
}

/**
 * The consent end, in seconds, recorded in a stored binding. A V3 binding has
 * its enrollment's end. A V4 binding has a sign-in authorization, which lasts
 * until withdrawn, so it is +Infinity; it never carries an enrollment end.
 */
export function studyConsentExpiry(row: {
  expires_at: number | null;
  version: number | null;
  authorization_id: string | null;
}) {
  if (row.version === 4) {
    studyCheck(
      row.expires_at == null &&
        typeof row.authorization_id === "string" &&
        /^0x[0-9a-f]{64}$/.test(row.authorization_id),
      "study_lesson_binding_invalid",
      503,
    );
    return Infinity;
  }
  studyCheck(row.expires_at != null, "study_lesson_binding_invalid", 503);
  return Number(row.expires_at);
}

export const STUDY_MAX_TAKES = 3;
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
  expiresAt: number;
  completedAt: number | null;
  status: "active" | "completed" | "abandoned" | "expired";
  completionReason:
    | "all_resolved"
    | "presentation_budget"
    | "left"
    | "deadline"
    | "consent_ended"
    | "never_bound"
    | "open_limit"
    | null;
  terminalAbsences: ("unattempted" | "unmeasured" | null)[] | null;
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
  expiresAt: number;
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
export function validateStudySongLines(song: StudySong, lines: StudyLine[]) {
  studyCheck(
    lines.length > 0 &&
      lines.length <= 2000 &&
      new Set(lines.map((l) => l.lineId)).size === lines.length,
    "invalid_study_lines",
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
  return validated;
}
export function newLesson(
  song: StudySong,
  lines: StudyLine[],
  now: number,
): LessonState {
  studyCheck(
    Number.isSafeInteger(now) && now >= 0 && now < STUDY_LESSON_NO_DEADLINE,
    "invalid_study_start",
  );
  studyCheck(
    lines.length >= 4 && lines.length <= 10,
    "insufficient_study_lines",
    409,
  );
  const validated = validateStudySongLines(song, lines);
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
    expiresAt: STUDY_LESSON_NO_DEADLINE,
    completedAt: null,
    status: "active",
    completionReason: null,
    terminalAbsences: null,
    presentationCount: 0,
    currentIndex: 0,
    currentAttemptId: null,
    lastAttemptId: null,
    takeNumber: 1,
  };
}

/**
 * Closure preserves first-pass facts and covers every frozen selected line.
 * Only a legacy lesson with a real deadline can be closed as expired.
 */
export function closeStudyLesson(
  state: LessonState,
  status: "abandoned" | "expired",
  now: number,
  submittedLineIds: ReadonlySet<string>,
  reason: "left" | "consent_ended" | "never_bound" | "open_limit" = "left",
): LessonState {
  studyCheck(state.status === "active", "study_lesson_changed", 409);
  studyCheck(
    Number.isSafeInteger(now) &&
      now >= state.startedAt &&
      (status === "expired"
        ? studyLessonHasDeadline(state) && now === state.expiresAt
        : now < state.expiresAt) &&
      (reason === "left" || !studyLessonHasDeadline(state)),
    "invalid_study_close_time",
  );
  return {
    ...structuredClone(state),
    status,
    completedAt: now,
    completionReason: status === "expired" ? "deadline" : reason,
    terminalAbsences: state.items.map((item) =>
      item.firstPassOutcome !== null
        ? null
        : submittedLineIds.has(item.line.lineId)
          ? "unmeasured"
          : "unattempted",
    ),
    currentIndex: null,
    currentAttemptId: null,
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
