// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-route-model.ts.
import type {
  StudyingAttemptResult,
  StudyingLessonState,
  StudyingServerExercise,
} from "./presentation/studying-model.ts";

// Client seam for the studying route. The route view owns no network, mic, or
// timer policy of its own: every effectful operation is one of these injected
// interfaces, so stories and tests mock them at the seam.

export interface StudyingLessonPayload {
  post_id: string;
  correct_count?: number;
  title?: string;
  artwork_src?: string;
  locked?: boolean;
  price_label?: string;
  /** Cards the server has resolved so far, when it reports them. */
  resolved_count?: number;
  served_count?: number;
  session_id?: string;
  /** Server-derived expiry retains progress but cannot accept another answer. */
  expired?: boolean;
  /** Authoritative current-card provider uncertainty, retained across reloads. */
  spoken_submission?: {
    state: "provider_outcome_unknown";
    session_item_id: string;
    attempt_number: number;
    next_action: "operator_review";
  } | null;
  /** Pre-session streak snapshot; only the completion slot animation reads it. */
  previous_streak?: number;
  reward_label?: string;
  exercises: StudyingServerExercise[];
}

interface StudyingAttemptBase {
  attempt_number: number;
  exercise_id: string;
  idempotency_key: string;
  session_id?: string;
}

export type StudyingAttemptInput =
  | (StudyingAttemptBase & {
      audio: Blob;
      audio_duration_ms: number;
      content_type: "audio/webm" | "audio/ogg" | "audio/mp4" | "audio/wav";
      type: "say_it_back";
    })
  | (StudyingAttemptBase & {
      selected_option_id: string;
      type: "translation_choice";
    });

export interface StudyingClient {
  loadLesson: (
    postId: string,
    signal?: AbortSignal,
  ) => Promise<StudyingLessonPayload>;
  submitAttempt: (
    input: StudyingAttemptInput,
  ) => Promise<StudyingAttemptResult>;
  /** Explicit fresh lesson only; reconciliation never creates one. */
  restartLesson?: () => Promise<StudyingLessonPayload>;
}

/** Microphone seam: start capture, then return the exact bounded audio bytes. */
export interface StudyingRecorder {
  start: () => Promise<void>;
  stop: () => Promise<{
    audio: Blob;
    contentType: "audio/webm" | "audio/ogg" | "audio/mp4" | "audio/wav";
    durationMs: number;
  }>;
  /**
   * Idempotently invalidates pending acquisition and stops any live capture.
   * Bound to route disposal so the microphone cannot outlive the surface.
   */
  cancel?: () => Promise<void>;
}

/** Rejection contract every studying client/recorder promise settles with. */
export interface StudyingAttemptRejection {
  status?: number;
  code?: string;
  message?: string;
  details?: unknown;
}

export function attemptErrorStatus(
  rejection: StudyingAttemptRejection,
): number | undefined {
  return rejection.status;
}

export function isStudyingAuthError(
  rejection: StudyingAttemptRejection,
): boolean {
  return (
    rejection.status === 401 ||
    rejection.status === 403 ||
    rejection.code === "auth_error" ||
    rejection.code === "unauthorized"
  );
}

export function errorMessage(
  rejection: StudyingAttemptRejection | null,
  fallback: string,
): string {
  return rejection?.message?.trim() ? rejection.message : fallback;
}

/** Header progress: the server's resolved-card count against the session size. */
export function lessonProgressOf(state: StudyingLessonState) {
  const totalCount = state.servedCount ?? state.exercises.length;
  const resolvedCount =
    state.resolvedCount ??
    Math.max(0, totalCount - (state.exercises.length === 0 ? 0 : 1));
  return {
    resolvedCount: Math.min(resolvedCount, totalCount),
    totalCount,
  };
}
