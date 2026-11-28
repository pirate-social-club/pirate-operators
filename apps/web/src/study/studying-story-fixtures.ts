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

export const storyPostId = `0x${"3".repeat(64)}`;

export const storySayItBackServerExercise: StudyingServerExercise = {
  id: "ex-say-1",
  type: "say_it_back",
  line_index: 0,
  max_attempts: 3,
  prompt_text: "Yo no sé por qué te fuiste tan temprano",
  reference_text: "Yo no sé por qué te fuiste tan temprano",
};

export const storySecondSayItBackServerExercise: StudyingServerExercise = {
  id: "ex-say-2",
  type: "say_it_back",
  line_index: 1,
  max_attempts: 3,
  prompt_text: "La luna sigue brillando sobre el mar",
  reference_text: "La luna sigue brillando sobre el mar",
};

export const storyThirdSayItBackServerExercise: StudyingServerExercise = {
  id: "ex-say-3",
  type: "say_it_back",
  line_index: 2,
  max_attempts: 3,
  prompt_text: "Cada palabra vuelve a su lugar",
  reference_text: "Cada palabra vuelve a su lugar",
};

export const storyFourthSayItBackServerExercise: StudyingServerExercise = {
  id: "ex-say-4",
  type: "say_it_back",
  line_index: 3,
  max_attempts: 3,
  prompt_text: "Cantamos hasta ver salir el sol",
  reference_text: "Cantamos hasta ver salir el sol",
};

const storySpokenExercises = [
  storySayItBackServerExercise,
  storySecondSayItBackServerExercise,
  storyThirdSayItBackServerExercise,
  storyFourthSayItBackServerExercise,
];

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
// spoken card, matching the operator payload. It carries no reward, streak or
// translation-choice fact.
export const storyLessonPayload: StudyingLessonPayload = {
  post_id: storyPostId,
  correct_count: 0,
  resolved_count: 0,
  served_count: 4,
  session_id: "ses_story1",
  spoken_submission: null,
  exercises: [storySayItBackServerExercise],
};

export function storyCorrectAttempt(input: StudyingAttemptInput) {
  if (input.type !== "say_it_back")
    throw Object.assign(
      new Error(
        "This community provides spoken Study cards. Translation cards are unavailable.",
      ),
      { code: "study_translation_unavailable" },
    );
  const index = storySpokenExercises.findIndex(
    (exercise) => exercise.id === input.exercise_id,
  );
  if (index < 0) throw new Error("Unknown spoken story exercise");
  const resolved = index + 1;
  const completing = resolved === storySpokenExercises.length;
  return {
    attempt_state: "spent" as const,
    attempts_remaining: 0,
    next_lesson: {
      exercises: completing ? [] : [storySpokenExercises[resolved]],
      resolved_count: resolved,
    },
    outcome: "correct" as const,
    session: {
      first_pass_correct_count: resolved,
      status: completing ? ("completed" as const) : ("active" as const),
    },
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

/** Client whose first load fails transiently and whose explicit retry succeeds. */
export function createRecoveringLoadClient(
  message = "Connection lost while loading the lesson.",
): StudyingClient {
  let failed = false;
  return {
    loadLesson: async () => {
      if (!failed) {
        failed = true;
        throw new Error(message);
      }
      return storyLessonPayload;
    },
    submitAttempt: async (input) => storyCorrectAttempt(input),
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
