// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-story-fixtures.ts.
// Shared fixtures for the studying Storybook stories. These mirror the shapes
// exercised in studying-model.test.ts; no fixture touches the network, the
// mic, or timers.
import type {
  StudyingMultipleChoiceExercise,
  StudyingSayItBackExercise,
  StudyingServerExercise,
} from "./presentation/studying-model.ts";
import {
  toMultipleChoiceExercise,
  toSayItBackExercise,
} from "./presentation/studying-model.ts";
import type {
  StudyingAttemptInput,
  StudyingClient,
  StudyingLessonPayload,
  StudyingRecorder,
} from "./studying-route-model";

export const storyPostId = "pst_study1";

export const storySayItBackServerExercise: StudyingServerExercise = {
  id: "ex-say-1",
  type: "say_it_back",
  line_index: 0,
  max_attempts: 3,
  prompt_text: "Yo no sé por qué te fuiste tan temprano",
  reference_text: "Yo no sé por qué te fuiste tan temprano",
  translation_text: "I don't know why you left so early",
};

export const storyMultipleChoiceServerExercise: StudyingServerExercise = {
  id: "ex-mc-1",
  type: "translation_choice",
  line_index: 1,
  max_attempts: 2,
  prompt_text: "Yo no sé por qué te fuiste tan temprano",
  question: "What does this line mean?",
  options: [
    { id: "opt-a", text: "I don't know why you left so early" },
    { id: "opt-b", text: "I know exactly when you arrived" },
    { id: "opt-c", text: "I never wanted you to stay here" },
    { id: "opt-d", text: "I don't remember what you told me" },
  ],
};

export const storySayItBackExercise: StudyingSayItBackExercise =
  toSayItBackExercise(storySayItBackServerExercise);

export const storyMultipleChoiceExercise: StudyingMultipleChoiceExercise =
  toMultipleChoiceExercise(storyMultipleChoiceServerExercise);

// Server-owned progression: the payload carries only the server's current
// card; the choice card arrives through the attempt result's next_lesson.
export const storyLessonPayload: StudyingLessonPayload = {
  post_id: storyPostId,
  title: "Paper Moon",
  resolved_count: 0,
  served_count: 2,
  session_id: "ses_story1",
  previous_streak: 4,
  reward_label: "+25 $MOON",
  exercises: [storySayItBackServerExercise],
};

export function storyCorrectAttempt(input: StudyingAttemptInput) {
  const completing = input.type === "translation_choice";
  return {
    attempt_state: "spent" as const,
    attempts_remaining: 0,
    correct_option_id:
      input.type === "translation_choice" ? "opt-a" : undefined,
    next_lesson: {
      exercises: completing ? [] : [storyMultipleChoiceServerExercise],
      resolved_count: completing ? 2 : 1,
    },
    outcome: "correct" as const,
    session: completing
      ? { first_pass_correct_count: 2, status: "completed" }
      : { first_pass_correct_count: 1, status: "active" },
    ...(completing
      ? {
          study_progress: {
            current_streak: 5,
            next_due_at: Math.floor(Date.now() / 1000) + 86_400,
            qualified_today: true,
            study_attempt_count: 2,
            study_correct_count: 2,
            study_target_count: 10,
          },
        }
      : {}),
  };
}

export function storyWrongAttempt(input: StudyingAttemptInput) {
  // Every graded spoken presentation is spent server-side: the miss is final
  // for this appearance and the lesson moves to the server's next card, with
  // the missed line returning later in the lesson.
  return {
    attempt_number: input.attempt_number,
    attempt_state: "spent" as const,
    attempts_remaining: 0,
    heard_transcript: "yo no sé por qué te fuiste",
    next_lesson: {
      exercises: [storyMultipleChoiceServerExercise],
      resolved_count: 0,
    },
    outcome: "incorrect" as const,
    session: { first_pass_correct_count: 0, status: "active" },
  };
}

/** Lesson client that always serves the story lesson. */
export function createStoryLessonClient(
  overrides: Partial<StudyingClient> = {},
): StudyingClient {
  return {
    loadLesson: async () => storyLessonPayload,
    submitAttempt: async (input) => storyCorrectAttempt(input),
    ...overrides,
  };
}

/** Client whose load answers 401, exercising the auth-required state. */
export function createAuthRequiredClient(): StudyingClient {
  const error = Object.assign(new Error("Sign in required"), { status: 401 });
  return {
    loadLesson: async () => {
      throw error;
    },
    submitAttempt: async () => {
      throw error;
    },
  };
}

/** Client whose load fails transiently, exercising the retry state. */
export function createFailingClient(
  message = "Connection lost while loading the lesson.",
): StudyingClient {
  return {
    loadLesson: async () => {
      throw new Error(message);
    },
    submitAttempt: async () => {
      throw new Error(message);
    },
  };
}

/** Recorder seam that never touches a real microphone. */
export function createStoryRecorder(): StudyingRecorder {
  return {
    start: async () => {},
    stop: async () => ({
      audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
      contentType: "audio/webm",
      durationMs: 1_000,
    }),
  };
}
