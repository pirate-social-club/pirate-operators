// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-surface.stories.tsx.
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, within } from "storybook/test";

import type { StudyingSurfaceState } from "./presentation/studying-model.ts";
import {
  StudyingSurface,
  type StudyingSurfaceProps,
} from "./presentation/studying-surface.tsx";
import {
  storyMultipleChoiceExercise,
  storySayItBackExercise,
} from "./studying-story-fixtures";

const meta = {
  title: "Flows/Studying/Session",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Presentational studying activity surface, ported from the legacy React `SongStudySurface`. " +
          "Every state is injected: the say-it-back phase machine (idle/listening/checking/wrong), " +
          "multiple choice with reveal styling, and completion. Recording, network, " +
          "and timers live at the route-view seam, never in this component. The production completion " +
          "sequence and exact-attempt streak reads are covered by Flows/Studying/Completion.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const lessonProgress = { resolvedCount: 1, totalCount: 3 };
const multipleChoiceProgress = { resolvedCount: 2, totalCount: 4 };
const completeProgress = { resolvedCount: 14, totalCount: 14 };
const noop = () => {};

function surface(
  state: StudyingSurfaceState,
  extra: Partial<StudyingSurfaceProps> = {},
) {
  return () => (
    <StudyingSurface
      lessonProgress={lessonProgress}
      onExit={noop}
      onOptionSelect={noop}
      onPrimaryAction={noop}
      state={state}
      {...extra}
    />
  );
}

export const SayItBackIdle: Story = {
  render: surface({
    kind: "say_it_back",
    attemptNumber: 1,
    exercise: storySayItBackExercise,
    phase: "idle",
  }),
  parameters: {
    docs: {
      description: {
        story: "First appearance of a say-it-back card, ready to record.",
      },
    },
  },
};

export const SayItBackListening: Story = {
  render: surface({
    kind: "say_it_back",
    attemptNumber: 1,
    exercise: storySayItBackExercise,
    phase: "listening",
  }),
  parameters: {
    docs: {
      description: {
        story:
          "Mic capture in progress; the footer flips to a secondary Stop action.",
      },
    },
  },
};

export const SayItBackChecking: Story = {
  render: surface({
    kind: "say_it_back",
    attemptNumber: 1,
    exercise: storySayItBackExercise,
    phase: "checking",
  }),
  parameters: {
    docs: {
      description: {
        story:
          "The recording is uploaded and scored; the footer is disabled while the attempt is in flight.",
      },
    },
  },
};

export const SayItBackWrongRetryable: Story = {
  render: surface({
    kind: "say_it_back",
    attemptNumber: 1,
    attemptsThisAppearance: 1,
    exercise: storySayItBackExercise,
    heardTranscript: "yo no se por que te fuiste",
    phase: "wrong",
  }),
  parameters: {
    docs: {
      description: {
        story:
          "A retryable miss reports Incorrect and keeps the learner on the same card.",
      },
    },
  },
};

export const SayItBackWrongSpentWillReturn: Story = {
  render: surface({
    kind: "say_it_back",
    attemptNumber: 2,
    attemptsThisAppearance: 2,
    exercise: storySayItBackExercise,
    heardTranscript: "yo no se por que",
    phase: "wrong",
    revealReference: true,
    willReturn: true,
  }),
  parameters: {
    docs: {
      description: {
        story:
          "Paper: a spent miss shows one Incorrect box with what was heard, and waits for Continue. No word diff and no 'comes back later' line.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = canvasElement.querySelector<HTMLElement>(
      "[data-study-result='incorrect']",
    );
    if (box === null) throw new Error("Expected the Incorrect box");
    await expect(within(box).getByText("Incorrect")).toBeVisible();
    await expect(
      within(box).getByText("You said: “yo no se por que”"),
    ).toBeVisible();
    await expect(
      canvasElement.querySelector("[data-transcript-diff]"),
    ).toBeNull();
    await expect(canvas.queryByText(/comes back later/u)).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Continue" }),
    ).toBeVisible();
    // Study's exit is a close mark: its cards cannot be revisited.
    await expect(
      canvas.getByRole("button", { name: "Exit study" }),
    ).toHaveAttribute("data-exit-icon", "close");
  },
};

export const MultipleChoiceIdle: Story = {
  render: surface(
    {
      kind: "multiple_choice",
      attemptNumber: 1,
      exercise: { ...storyMultipleChoiceExercise, question: "Translate:" },
    },
    { lessonProgress: multipleChoiceProgress },
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Unanswered translation-choice card; the server withholds the correct option until an attempt lands.",
      },
    },
  },
};

export const MultipleChoiceSelected: Story = {
  render: surface(
    {
      kind: "multiple_choice",
      attemptNumber: 1,
      exercise: storyMultipleChoiceExercise,
      selectedOptionId: "opt-a",
      submitting: true,
    },
    { lessonProgress: multipleChoiceProgress },
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Engineering-only in-flight boundary, nearest Paper choice-ready: the selected card stays in place and locks until the grading response. No dedicated Checking screen, result or Next is shown yet.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const choices = canvas.getByRole("group", { name: "Answer choices" });
    await expect(choices).toHaveAttribute("aria-busy", "true");
    const options = within(choices).getAllByRole("button");
    await expect(options).toHaveLength(4);
    for (const option of options) await expect(option).toBeDisabled();
    await expect(canvas.queryByRole("button", { name: /Checking/ })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Next" })).toBeNull();
    await expect(canvasElement.querySelector("[data-study-result]")).toBeNull();
  },
};

export const MultipleChoiceCorrect: Story = {
  render: surface(
    {
      kind: "multiple_choice",
      attemptNumber: 1,
      exercise: { ...storyMultipleChoiceExercise, correctOptionId: "opt-a" },
      result: "correct",
      selectedOptionId: "opt-a",
    },
    { lessonProgress: multipleChoiceProgress },
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Paper correct feedback and semantic success tokens; latest owner instruction adds explicit Next for both outcomes, superseding the old automatic advance. This static snapshot does not simulate progression.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = canvasElement.querySelector<HTMLElement>(
      "[data-study-result='correct']",
    );
    if (box === null) throw new Error("Expected the Correct box");
    await expect(within(box).getByText("Correct")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Continue" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Next" })).toBeEnabled();
    await expect(canvas.queryByRole("button", { name: /Checking/ })).toBeNull();
  },
};

export const MultipleChoiceWrong: Story = {
  render: surface(
    {
      kind: "multiple_choice",
      attemptNumber: 1,
      exercise: { ...storyMultipleChoiceExercise, correctOptionId: "opt-a" },
      result: "wrong",
      selectedOptionId: "opt-c",
      canRetry: true,
    },
    { lessonProgress: multipleChoiceProgress },
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Paper wrong feedback: the missed selection and a server-disclosed correct option are marked. The latest owner instruction requires Next; the route either presents the server's retry or its next card.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = canvasElement.querySelector<HTMLElement>(
      "[data-study-result='incorrect']",
    );
    if (box === null) throw new Error("Expected the Incorrect box");
    await expect(within(box).getByText("Incorrect")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Next" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Try again" }),
    ).toBeNull();
    // Paper's desktop column is 640 wide, header included: the header is
    // centred and lines up with the card column.
    if (window.innerWidth >= 768) {
      const column = box.parentElement!.getBoundingClientRect();
      await expect(Math.round(column.width)).toBe(640);
      const header = canvasElement
        .querySelector<HTMLElement>("[data-study-header] header")!
        .getBoundingClientRect();
      await expect(Math.round(header.width)).toBe(640);
      await expect(Math.round(header.left)).toBe(Math.round(column.left));
      await expect(Math.round(header.right)).toBe(Math.round(column.right));
      await expect(
        Math.abs(header.left - (window.innerWidth - header.right)),
      ).toBeLessThanOrEqual(1);
    }
  },
};

export const MultipleChoiceSubmitError: Story = {
  render: surface({
    kind: "multiple_choice",
    attemptNumber: 1,
    exercise: storyMultipleChoiceExercise,
    submitError: "Could not record this answer. Try again.",
  }),
};

export const Complete: Story = {
  render: surface(
    {
      kind: "complete",
      correctCount: 12,
      scorePercent: 86,
      totalCount: 14,
    },
    {
      lessonProgress: completeProgress,
      onExit: noop,
      onKaraoke: noop,
      onStudyAgain: noop,
    },
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Production results page: accuracy, correct and missed tiles, one Continue back to the song and a quiet Study again. No reward or streak is claimed.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Great work!" }),
    ).toBeInTheDocument();
    await expect(canvas.getByText("12/14")).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Study again" }),
    ).toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: "Karaoke" }),
    ).not.toBeInTheDocument();
  },
};

export const CompleteMobile: Story = {
  ...Complete,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};

export const CompleteLowScore: Story = {
  render: surface(
    {
      kind: "complete",
      correctCount: 4,
      scorePercent: (4 / 14) * 100,
      totalCount: 14,
    },
    { lessonProgress: completeProgress, onExit: noop, onStudyAgain: noop },
  ),
  parameters: {
    docs: {
      description: {
        story:
          "A low score keeps the encouragement honest and the same single Continue.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("heading", { name: "Keep practising!" }),
    ).toBeInTheDocument();
  },
};

export const NoReward: Story = {
  render: () => (
    <StudyingSurface
      lessonProgress={lessonProgress}
      onExit={noop}
      onPrimaryAction={noop}
      state={{
        kind: "say_it_back",
        attemptNumber: 1,
        exercise: storySayItBackExercise,
        phase: "idle",
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Without an active campaign the header capsule holds only the progress bar.",
      },
    },
  },
};
