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
    (current.attempt?.state === "assessing" ||
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
  if (attempt.state === "assessing" || attempt.state === "uncertain")
    throw reviewRequired();
  if (attempt.state !== "assessed" || !attempt.grade)
    throw refused(
      lesson.speechRetryAfter
        ? "Speech is busy. Your answer was not counted. Wait a minute, then try again."
        : "The speech service declined that recording. Record a new answer.",
    );
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
export function createOperatorStudyingClient(
  client: StudyClient,
  onLesson?: (lesson: StudyLesson) => void,
): StudyingClient {
  let lesson: StudyLesson | undefined;
  let pending: Promise<StudyingAttemptResult> | undefined;
  let pendingInput: Parameters<StudyingClient["submitAttempt"]>[0] | undefined;
  let reconciliationRequired = false;
  const remember = (value: StudyLesson) => {
    lesson = value;
    onLesson?.(value);
    return operatorStudyPayload(value);
  };
  async function reconcile(attemptId?: string): Promise<StudyingAttemptResult> {
    let saved: StudyLesson;
    try {
      saved = await client.refresh();
    } catch (error) {
      if (
        (error as { status?: number }).status === 401 ||
        (error as { code?: string }).code === "study_account_changed"
      )
        throw error;
      reconciliationRequired = true;
      throw reviewRequired();
    }
    remember(saved);
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
    async loadLesson() {
      const value =
        lesson || reconciliationRequired
          ? await client.refresh()
          : await client.load();
      reconciliationRequired = false;
      return remember(value);
    },
    async restartLesson() {
      if (pending) throw reviewRequired();
      try {
        return remember(await client.restart());
      } catch (error) {
        reconciliationRequired = true;
        throw error;
      }
    },
    submitAttempt(input) {
      if (pending)
        return pendingInput === input
          ? pending
          : Promise.reject(reviewRequired());
      if (reconciliationRequired) return Promise.reject(reviewRequired());
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
        current.current.attempt?.state === "assessing" ||
        current.current.attempt?.state === "uncertain" ||
        current.current.takeNumber > STUDY_MAX_TAKES
      )
        return Promise.reject(reviewRequired());
      const run = async () => {
        let opened: StudyAttempt | undefined;
        let result: StudyLessonSubmission;
        try {
          opened = (await client.open(current)).attempt;
          if (opened.state === "assessing" || opened.state === "uncertain")
            throw reviewRequired();
          if (opened.state === "assessed") return reconcile(opened.attemptId);
          result = await client.submit(
            current.lessonId,
            opened.attemptId,
            input.audio,
            input.audio_duration_ms,
          );
        } catch (error) {
          if (
            (error as { status?: number }).status === 401 ||
            (error as { code?: string }).code === "study_account_changed"
          )
            throw error;
          return reconcile(opened?.attemptId);
        }
        remember(result.lesson);
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
