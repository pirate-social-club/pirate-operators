// Adopted from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-model.ts; only imports changed.
// Framework-pure studying lesson model, ported from the legacy React app
// (`web/src/app/authenticated-routes/study-route.tsx` and
// `web/src/components/compositions/song-study/song-study-surface.tsx`, source
// checkout 0bc2ea7e8d427b5f5be8824d3943dad29c800f2c). No React, no network,
// no timers, no browser APIs — the route view owns those seams.
//
// Server shapes are the api-next snake_case wire fields, mirrored as local
// types so this module never imports a legacy contract package.

export interface StudyingSayItBackExercise {
  id: string;
  lineNumber: number;
  maxAttempts: number;
  prompt: string;
  translation?: string;
  expected: string;
}

export interface StudyingMultipleChoiceOption {
  id: string;
  text: string;
}

export interface StudyingMultipleChoiceExercise {
  id: string;
  lineNumber: number;
  maxAttempts: number;
  prompt: string;
  question: string;
  options: StudyingMultipleChoiceOption[];
  correctOptionId: string;
}

export type StudyingSurfaceState =
  | {
    kind: "locked";
    priceLabel?: string;
  }
  | {
    kind: "say_it_back";
    attemptNumber: number;
    /** Attempts spent on this appearance of the card (not across the lesson). */
    attemptsThisAppearance?: number;
    exercise: StudyingSayItBackExercise;
    guidance?: string;
    /** What speech-to-text heard on the last miss. Shown only while `phase` is "wrong". */
    heardTranscript?: string;
    /** Token diff for the last miss, preserved for the wrong-phase feedback. */
    diff?: StudyingTranscriptDiff;
    phase: "idle" | "acquiring" | "listening" | "checking" | "blocked" | "wrong";
    /** True once the card is spent, so the miss is final rather than retryable. */
    revealReference?: boolean;
    /** Whether a spent card is coming back later in this lesson. */
    willReturn?: boolean;
    submitError?: string;
  }
  | {
    kind: "multiple_choice";
    attemptNumber: number;
    canRetry?: boolean;
    exercise: StudyingMultipleChoiceExercise;
    result?: "correct" | "wrong";
    selectedOptionId?: string;
    submitError?: string;
    submitting?: boolean;
  }
  | {
    kind: "complete";
    correctCount: number;
    nextReviewLabel?: string;
    /** Pre-session streak, used only for the slot-number animation. */
    previousStreak?: number;
    scorePercent: number;
    streak?: {
      currentStreak: number;
      qualifiedToday: boolean;
      studyAttemptsToday?: number;
      studyCorrectCount?: number;
      studyTargetCount?: number;
    };
    /** Seven booleans, Monday through Sunday, for the streak completion view. */
    streakWeek?: readonly boolean[];
    totalCount: number;
  };

/** Server exercise wire shape (api-next snake_case). */
export interface StudyingServerExercise {
  id: string;
  type: "say_it_back" | "translation_choice";
  line_index: number;
  max_attempts?: number;
  prompt_text: string;
  reference_text?: string;
  translation_text?: string | null;
  question?: string;
  options?: StudyingMultipleChoiceOption[];
  presentation_count?: number;
}

/** Token-level transcript diff from the spoken grader. */
export interface StudyingTranscriptDiff {
  extra: readonly string[];
  match_kind: "exact" | "phonetic" | "none";
  matched: readonly { token: string; position: number }[];
  missing: readonly { token: string; position: number }[];
  substituted: readonly {
    expected: { token: string; position: number };
    heard: string;
  }[];
}

/** Server attempt-result wire fields the lesson model reads. */
export interface StudyingAttemptResult {
  attempt_state?: "retryable" | "spent";
  attempts_remaining?: number;
  correct_option_id?: string;
  heard_transcript?: string;
  /** How the grader matched: exact, phonetic, or none. */
  match_kind?: "exact" | "phonetic" | "none";
  /** Token-level transcript diff from the spoken grader, when provided. */
  diff?: StudyingTranscriptDiff;
  next_lesson?: {
    exercises: StudyingServerExercise[];
    expired?: boolean;
    resolved_count?: number;
  };
  outcome?: "correct" | "incorrect" | "ungraded_rerecord";
  session?: {
    first_pass_correct_count?: number;
    status?: string;
  };
  study_progress?: {
    current_streak: number;
    next_due_at?: number;
    qualified_today: boolean;
    study_attempt_count: number;
    study_correct_count: number;
    study_target_count: number;
  };
}

export interface StudyingLessonState {
  correctCount: number;
  exercises: StudyingServerExercise[];
  lastAttemptResult?: StudyingAttemptResult;
  /** Pre-session streak snapshot; only the completion slot animation reads it. */
  previousStreak?: number;
  resolvedCount?: number;
  servedCount?: number;
  surface: StudyingSurfaceState;
}

// A rejected attempt with one of these statuses means our cached view of the
// session diverged from the server's: the card is spent, it is already
// mastered, the attempt number no longer lines up, or the idempotency key was
// replayed with a different payload. Re-sending the identical attempt can only
// fail the same way, so the only recovery is to re-read the session and
// rebuild from server truth.
export const STUDY_ATTEMPT_DIVERGENCE_STATUSES: ReadonlySet<number> = new Set([400, 404, 409]);

// Recovering silently is safe in both directions: if the rejected attempt was
// in fact recorded server-side (a lost response), the reload shows the
// advanced state; if it was never recorded, the same card comes back at the
// same attempt number and the cached idempotency key is still unused.
export const STUDY_ATTEMPT_DIVERGENCE_RECOVERY_LIMIT = 2;

/** Legacy checked `error instanceof ApiError`; the pure seam takes the status. */
export function isStudyAttemptDivergence(status: number | null | undefined): boolean {
  return typeof status === "number" && STUDY_ATTEMPT_DIVERGENCE_STATUSES.has(status);
}

export function makeAttemptIdempotencyKey(
  sessionId: string,
  exerciseId: string,
  attemptNumber: number,
  random: string = defaultIdempotencyRandom(),
): string {
  return `study:${sessionId}:${exerciseId}:${attemptNumber}:${random}`;
}

/**
 * The api-next answer contract bounds the idempotency key at 128 characters
 * (`Identifier`); real session and session-item identifiers already consume
 * most of that budget, so the random suffix must stay short. Six random bytes
 * keep the composite key within the bound while preserving per-mount
 * uniqueness; the fallback path is bounded to the same length so an
 * environment without `crypto.getRandomValues` cannot exceed it either.
 */
function defaultIdempotencyRandom(): string {
  const bytes = new Uint8Array(6);
  if (globalThis.crypto?.getRandomValues !== undefined) {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let suffix = "";
  while (suffix.length < 12) suffix += Math.floor(Math.random() * 36).toString(36);
  return suffix;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function primaryActionLabel(
  state: StudyingSurfaceState,
  sayItBackIdleLabel?: string,
): string | undefined {
  switch (state.kind) {
    case "locked":
      return state.priceLabel ? `Buy ${state.priceLabel}` : "Buy";
    case "say_it_back":
      if (state.phase === "wrong") return state.revealReference ? "Continue" : "Record";
      if (state.phase === "checking") return "Checking…";
      if (state.phase === "acquiring") return "Starting microphone…";
      if (state.phase === "blocked") return "Recording paused";
      return state.phase === "listening" ? "Stop" : sayItBackIdleLabel ?? "Record";
    case "multiple_choice":
      if (state.submitting) return "Checking…";
      // Paper (owner, 2026-10-12): a correct answer moves on by itself, so
      // it has no button; an incorrect one pauses on Continue. When the
      // server keeps the same card for another attempt, Continue shows it
      // again, as its next card.
      return state.result === "wrong" ? "Continue" : undefined;
    case "complete":
      return undefined;
  }
}

export function primaryActionVariant(state: StudyingSurfaceState): "default" | "destructive" | "secondary" {
  if (state.kind === "say_it_back" && state.phase === "listening") return "secondary";
  return "default";
}

export function primaryActionDisabled(state: StudyingSurfaceState): boolean {
  if (state.kind === "multiple_choice") return Boolean(state.submitting);
  if (state.kind === "say_it_back") return state.phase === "checking" || state.phase === "acquiring" || state.phase === "blocked";
  return false;
}

export function previousStreakForAnimation(
  streak: { currentStreak: number } | undefined,
  previousStreak: number | undefined,
): number | undefined {
  if (!streak || previousStreak === undefined) return undefined;
  return Math.max(0, Math.min(previousStreak, streak.currentStreak));
}

export function lockedSurface(priceLabel?: string): StudyingSurfaceState {
  return { kind: "locked", priceLabel };
}

export function toSayItBackExercise(
  exercise: StudyingServerExercise,
): StudyingSayItBackExercise {
  const prompt = exercise.prompt_text || exercise.reference_text || "Listen to the line and say it back.";
  return {
    id: exercise.id,
    lineNumber: exercise.line_index + 1,
    maxAttempts: Math.max(1, exercise.max_attempts || 1),
    prompt,
    translation: exercise.translation_text ?? undefined,
    expected: exercise.reference_text || prompt,
  };
}

export function toMultipleChoiceExercise(
  exercise: StudyingServerExercise,
): StudyingMultipleChoiceExercise {
  return {
    id: exercise.id,
    lineNumber: exercise.line_index + 1,
    maxAttempts: Math.max(1, exercise.max_attempts || 1),
    options: exercise.options ?? [],
    prompt: exercise.prompt_text,
    question: exercise.question ?? "",
    // The server deliberately withholds this until an attempt is spent. The
    // surface needs the field for reveal styling; keep it empty until the
    // attempt response discloses it.
    correctOptionId: "",
  };
}

export function exerciseSurface(
  exercise: StudyingServerExercise,
  attemptNumber = Number(exercise.presentation_count ?? 0) + 1,
): StudyingSurfaceState {
  return exercise.type === "translation_choice"
    ? {
        kind: "multiple_choice",
        attemptNumber,
        exercise: toMultipleChoiceExercise(exercise),
      }
    : {
        kind: "say_it_back",
        attemptNumber,
        exercise: toSayItBackExercise(exercise),
        phase: "idle",
      };
}

export function formatNextReviewLabel(nextDueAt?: number, now: number = Date.now()): string | undefined {
  if (!nextDueAt) return undefined;
  const dueMs = nextDueAt * 1000;
  const deltaMs = dueMs - now;
  if (!Number.isFinite(deltaMs)) return undefined;
  if (deltaMs <= 60_000) return "soon";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(deltaMs / 3_600_000);
  if (hours < 24) return `in ${hours} hr`;
  const days = Math.round(deltaMs / 86_400_000);
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days} days`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(dueMs));
}

export function caughtUpMessage(nextDueAt?: number, now?: number): string {
  const nextReviewLabel = formatNextReviewLabel(nextDueAt, now);
  if (!nextReviewLabel) return "You're caught up for this song.";
  return `You're caught up for this song. Review again ${nextReviewLabel} to keep going.`;
}

export function completeSurface(input: {
  correctCount: number;
  lastAttemptResult?: StudyingAttemptResult;
  previousStreak?: number;
  totalCount: number;
}): StudyingSurfaceState {
  const progress = input.lastAttemptResult?.study_progress;
  return {
    kind: "complete",
    correctCount: input.correctCount,
    nextReviewLabel: formatNextReviewLabel(progress?.next_due_at),
    previousStreak: input.previousStreak,
    scorePercent: input.totalCount > 0 ? (input.correctCount / input.totalCount) * 100 : 0,
    ...(progress
      ? {
          streak: {
            currentStreak: progress.current_streak,
            qualifiedToday: progress.qualified_today,
            studyAttemptsToday: progress.study_attempt_count,
            studyCorrectCount: progress.study_correct_count,
            studyTargetCount: progress.study_target_count,
          },
        }
      : {}),
    totalCount: input.totalCount,
  };
}

/**
 * Applies the server's post-answer lesson state. The returned session is the
 * single progression authority: the next surface is the server's current card
 * at its real presentation number, and completion requires the server to have
 * completed the lesson — never a drained local queue.
 */
export function applyServerLesson(
  state: StudyingLessonState,
  result: StudyingAttemptResult,
): StudyingLessonState {
  const lesson = result.next_lesson;
  if (lesson === undefined) return state;
  const correctCount = result.session?.first_pass_correct_count ?? state.correctCount;
  const resolvedCount = lesson.resolved_count ?? state.resolvedCount;
  const nextExercise = lesson.exercises[0];
  const totalCount = state.servedCount ?? state.exercises.length;
  if (nextExercise === undefined) {
    return {
      ...state,
      correctCount,
      lastAttemptResult: result,
      resolvedCount,
      surface: completeSurface({
        correctCount,
        lastAttemptResult: result,
        previousStreak: state.previousStreak,
        totalCount,
      }),
    };
  }
  return {
    ...state,
    correctCount,
    exercises: [nextExercise],
    lastAttemptResult: result,
    resolvedCount,
    surface: exerciseSurface(nextExercise),
  };
}
