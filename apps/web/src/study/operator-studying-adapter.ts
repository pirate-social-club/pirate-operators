import type { StudyAttempt } from "../../../../packages/study/contracts.ts";
import type {
  StudyLesson,
  StudyLessonSubmission,
} from "../../../../packages/study/lesson.ts";
import { STUDY_MAX_TAKES } from "../../../../packages/study/lesson.ts";
import type { StudyClient } from "./client.ts";
import type {
  StudyingAttemptResult,
  StudyingServerExercise,
} from "./presentation/studying-model.ts";
import type {
  StudyingClient,
  StudyingLessonPayload,
} from "./studying-route-model.ts";

/** Maps facts, never grades, advances a queue, or manufactures qualification. */
export function operatorStudyPayload(
  value: StudyLesson,
): StudyingLessonPayload {
  const current = value.current;
  const blocked =
    current &&
    (current.attempt?.state === "ready" ||
      current.attempt?.state === "assessing" ||
      current.attempt?.state === "uncertain" ||
      current.takeNumber > STUDY_MAX_TAKES);
  const exercises: StudyingServerExercise[] = current
    ? [
        {
          id: current.line.lineId,
          type: "say_it_back",
          // No source ordinal is provided by this protocol. This field is not rendered.
          line_index: -1,
          max_attempts: STUDY_MAX_TAKES,
          presentation_count: current.presentationNumber - 1,
          prompt_text: current.line.text,
          reference_text: current.line.text,
        },
      ]
    : [];
  if (value.status === "active" && !current)
    throw new Error(
      "The saved lesson has no current card. Check its status before recording.",
    );
  return {
    post_id: value.song.postId,
    session_id: value.lessonId,
    correct_count: value.progress.firstPassCorrect,
    resolved_count: value.progress.resolved,
    served_count: value.progress.total,
    expired: value.status === "expired" || value.status === "abandoned",
    exercises,
    spoken_submission: blocked
      ? {
          state: "provider_outcome_unknown",
          session_item_id: current.line.lineId,
          attempt_number: current.presentationNumber,
          next_action: "operator_review",
        }
      : null,
  };
}

const reviewRequired = () =>
  Object.assign(new Error("The recording outcome is still being checked."), {
    status: 409,
    details: {
      reason_code: "study_provider_outcome_unknown",
      next_action: "operator_review",
    },
  });
const refused = (message: string) =>
  Object.assign(new Error(message), {
    status: 409,
    details: {
      reason_code: "study_provider_refused",
      next_action: "record_again",
    },
  });

export function operatorStudyResult(
  result: StudyLessonSubmission,
): StudyingAttemptResult {
  const { attempt, lesson } = result;
  if (attempt.state === "unavailable")
    throw refused(
      lesson.speechRetryAfter
        ? "Speech is busy. Your answer was not counted. Wait a minute, then try again."
        : "The speech service declined that recording. Record a new answer.",
    );
  // The server reads an upload body before claiming assessing. A ready
  // readback can race that still-live upload; it proves no provider refusal.
  if (attempt.state !== "assessed" || !attempt.grade) throw reviewRequired();
  const grade = attempt.grade;
  const next = operatorStudyPayload(lesson);
  if (next.spoken_submission) throw reviewRequired();
  return {
    attempt_state: "spent",
    attempts_remaining: 0,
    outcome: grade.rerecordReason
      ? "ungraded_rerecord"
      : grade.correct
        ? "correct"
        : "incorrect",
    heard_transcript: grade.heardTranscript,
    match_kind: grade.matchKind,
    ...(grade.matched && grade.missing && grade.extra && grade.substituted
      ? {
          diff: {
            match_kind: grade.matchKind,
            matched: grade.matched,
            missing: grade.missing,
            extra: grade.extra,
            substituted: grade.substituted,
          },
        }
      : {}),
    next_lesson: {
      exercises: next.exercises,
      resolved_count: next.resolved_count,
      expired: next.expired,
    },
    session: {
      status: lesson.status,
      first_pass_correct_count: lesson.progress.firstPassCorrect,
    },
  };
}

/** Source controller seam over the owned decentralized lesson port. A failed
 * upload is reconciled on the SAME lesson/attempt. Admission remains server-owned.
 */
export interface OperatorStudyingClient extends StudyingClient {
  dispose(): void;
}
export function createOperatorStudyingClient(
  client: StudyClient,
  onLesson?: (lesson: StudyLesson) => void,
  options: { isActive?: () => boolean; onLoading?: () => void } = {},
): OperatorStudyingClient {
  let lesson: StudyLesson | undefined;
  let pending: Promise<StudyingAttemptResult> | undefined;
  let pendingInput: Parameters<StudyingClient["submitAttempt"]>[0] | undefined;
  let reconciliationRequired = false;
  let active = true,
    generation = 0;
  let unresolvedUpload:
    | {
        lessonId: string;
        attemptId: string;
        input: Parameters<StudyingClient["submitAttempt"]>[0];
      }
    | undefined;
  const ensureCurrent = (revision = generation) => {
    if (!active || options.isActive?.() === false || revision !== generation)
      throw Object.assign(new Error("This Study was closed or replaced."), {
        code: "study_view_closed",
      });
  };
  const remember = (value: StudyLesson, revision = generation) => {
    ensureCurrent(revision);
    lesson = value;
    if (unresolvedUpload?.lessonId === value.lessonId) {
      const known =
        value.lastAttempt?.attemptId === unresolvedUpload.attemptId
          ? value.lastAttempt
          : value.current?.attempt?.attemptId === unresolvedUpload.attemptId
            ? value.current.attempt
            : null;
      if (
        value.status !== "active" ||
        known?.state === "unavailable" ||
        (known?.state === "assessed" && known.grade)
      )
        unresolvedUpload = undefined;
    }
    onLesson?.(value);
    ensureCurrent(revision);
    const payload = operatorStudyPayload(value);
    // Retain the original audio/attempt marker across reloads. Never enable
    // replacement audio merely because this read still says ready or omits it.
    if (unresolvedUpload && payload.exercises[0] && value.status === "active")
      payload.spoken_submission = {
        state: "provider_outcome_unknown",
        session_item_id: payload.exercises[0].id,
        attempt_number: value.current!.presentationNumber,
        next_action: "operator_review",
      };
    return payload;
  };
  async function reconcile(
    attemptId: string | undefined,
    revision: number,
  ): Promise<StudyingAttemptResult> {
    let saved: StudyLesson;
    try {
      saved = await client.refresh();
    } catch (error) {
      ensureCurrent(revision);
      if (
        (error as { status?: number }).status === 401 ||
        (error as { code?: string }).code === "study_account_changed"
      )
        throw error;
      reconciliationRequired = true;
      throw reviewRequired();
    }
    remember(saved, revision);
    const prior =
      attemptId &&
      (saved.lastAttempt?.attemptId === attemptId
        ? saved.lastAttempt
        : saved.current?.attempt?.attemptId === attemptId
          ? saved.current.attempt
          : null);
    if (prior) return operatorStudyResult({ lesson: saved, attempt: prior });
    // Readback proved queue state, not this dispatch's outcome. Reload without
    // inventing a grade or reserving another attempt.
    throw Object.assign(new Error("Your saved lesson was refreshed."), {
      status: 409,
    });
  }
  return {
    dispose() {
      active = false;
      generation += 1;
      lesson = undefined;
      unresolvedUpload = undefined;
      pendingInput = undefined;
    },
    async loadLesson() {
      ensureCurrent();
      const revision = ++generation;
      options.onLoading?.();
      ensureCurrent(revision);
      const value =
        lesson || reconciliationRequired
          ? await client.refresh()
          : await client.load();
      reconciliationRequired = false;
      return remember(value, revision);
    },
    async restartLesson() {
      ensureCurrent();
      if (pending) throw reviewRequired();
      const revision = ++generation;
      options.onLoading?.();
      ensureCurrent(revision);
      try {
        const value = await client.restart();
        ensureCurrent(revision);
        // restart() has authoritatively closed the old lesson before creating
        // this one. Only that explicit action may leave an unresolved lesson.
        if (
          unresolvedUpload?.lessonId === value.lessonId &&
          value.status === "active"
        )
          throw reviewRequired();
        unresolvedUpload = undefined;
        return remember(value, revision);
      } catch (error) {
        ensureCurrent(revision);
        reconciliationRequired = true;
        throw error;
      }
    },
    submitAttempt(input) {
      try {
        ensureCurrent();
      } catch (error) {
        return Promise.reject(error);
      }
      if (pending)
        return pendingInput === input
          ? pending
          : Promise.reject(reviewRequired());
      if (reconciliationRequired || unresolvedUpload)
        return Promise.reject(reviewRequired());
      if (input.type !== "say_it_back")
        return Promise.reject(
          Object.assign(
            new Error(
              "This community provides spoken Study cards. Translation cards are unavailable.",
            ),
            { code: "study_translation_unavailable" },
          ),
        );
      const current = lesson;
      if (
        !current?.current ||
        input.session_id !== current.lessonId ||
        input.exercise_id !== current.current.line.lineId ||
        input.attempt_number !== current.current.presentationNumber
      )
        return Promise.reject(
          Object.assign(
            new Error("The saved card changed. Refresh the lesson."),
            { status: 409 },
          ),
        );
      if (
        current.current.attempt?.state === "ready" ||
        current.current.attempt?.state === "assessing" ||
        current.current.attempt?.state === "uncertain" ||
        current.current.takeNumber > STUDY_MAX_TAKES
      )
        return Promise.reject(reviewRequired());
      const run = async () => {
        const revision = generation;
        let opened: StudyAttempt | undefined;
        let result: StudyLessonSubmission;
        try {
          opened = (await client.open(current)).attempt;
          ensureCurrent(revision);
          if (opened.state === "assessing" || opened.state === "uncertain")
            throw reviewRequired();
          if (opened.state === "assessed")
            return reconcile(opened.attemptId, revision);
          unresolvedUpload = {
            lessonId: current.lessonId,
            attemptId: opened.attemptId,
            input,
          };
          result = await client.submit(
            current.lessonId,
            opened.attemptId,
            input.audio,
            input.audio_duration_ms,
          );
        } catch (error) {
          ensureCurrent(revision);
          if (
            (error as { status?: number }).status === 401 ||
            (error as { code?: string }).code === "study_account_changed"
          )
            throw error;
          return reconcile(opened?.attemptId, revision);
        }
        ensureCurrent(revision);
        if (
          result.lesson.lessonId !== current.lessonId ||
          result.attempt.attemptId !== opened!.attemptId
        )
          throw reviewRequired();
        if (
          result.attempt.state === "unavailable" ||
          (result.attempt.state === "assessed" && result.attempt.grade)
        )
          unresolvedUpload = undefined;
        remember(result.lesson, revision);
        return operatorStudyResult(result);
      };
      pendingInput = input;
      pending = run().finally(() => {
        pending = undefined;
        pendingInput = undefined;
      });
      return pending;
    },
  };
}
