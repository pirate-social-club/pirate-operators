// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-route-view.stories.tsx.
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { StudyingRouteView } from "./studying-route-view";
import {
  createAuthRequiredClient,
  createFailingClient,
  createStoryLessonClient,
  createStoryRecorder,
  storyCorrectAttempt,
  storyLessonPayload,
  storyPostId,
  storyWrongAttempt,
} from "./studying-story-fixtures";

const meta = {
  title: "Screens/Studying/Route",
  decorators: [
    (Story) => (
      <main class="min-h-dvh bg-background text-foreground">
        <Story />
      </main>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The studying route driven through its injected seams: a mocked lesson client and a fake recorder. " +
          "No network or microphone: answers wait for the injected grading response, retain feedback, and advance only through explicit Next.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const noop = () => {};
export const RecordingOutcomeUnknown: Story = {
  render: () => (
    <StudyingRouteView
      client={createStoryLessonClient({
        loadLesson: async () => ({
          ...storyLessonPayload,
          spoken_submission: {
            state: "provider_outcome_unknown",
            session_item_id: "ex-say-1",
            attempt_number: 1,
            next_action: "operator_review",
          },
        }),
      })}
      onExit={noop}
      onStudyAgain={noop}
      postId={storyPostId}
      recorder={createStoryRecorder()}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Recording paused" }),
    ).toBeDisabled();
    await expect(
      canvas.getByRole("button", { name: "Study again" }),
    ).toBeEnabled();
    await expect(
      canvas.getByText(/start over with a new lesson/),
    ).toBeInTheDocument();
  },
};

export const ExpiredLesson: Story = {
  render: () => (
    <StudyingRouteView
      client={createStoryLessonClient({
        loadLesson: async () => ({
          ...storyLessonPayload,
          expired: true,
          resolved_count: 2,
          served_count: 4,
          exercises: [],
        }),
      })}
      onExit={noop}
      onStudyAgain={noop}
      postId={storyPostId}
      recorder={createStoryRecorder()}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Study session expired" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByText("2 of 4 cards resolved."),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Record" })).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Start new lesson" }),
    ).toBeEnabled();
  },
};

export const LessonFlow: Story = {
  render: () => (
    <StudyingRouteView
      client={createStoryLessonClient()}
      onExit={noop}
      onStudyAgain={noop}
      postId={storyPostId}
      recorder={createStoryRecorder()}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Happy path: record the say-it-back card (Stop submits a correct attempt and the server advances to its current card), then answer the multiple-choice card, inspect feedback and press Next to reach streak-qualified completion.",
      },
    },
  },
};

export const MissedAttempts: Story = {
  render: () => (
    <StudyingRouteView
      client={createStoryLessonClient({
        submitAttempt: async (input) => storyWrongAttempt(input),
      })}
      onExit={noop}
      postId={storyPostId}
      recorder={createStoryRecorder()}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Every attempt misses: each graded spoken presentation is spent server-side, so the miss reveals the transcript feedback and Continue moves to the server's next card; the missed line returns later in the lesson.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(
      await canvas.findByRole("button", { name: "Record" }),
    );

    // The miss is final for this appearance: feedback, then Continue.
    await userEvent.click(await canvas.findByRole("button", { name: "Stop" }));
    await expect(await canvas.findByText(/Incorrect/)).toBeInTheDocument();
    await expect(await canvas.findByText(/You said:/)).toBeInTheDocument();
    await expect(
      await canvas.findByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();

    await userEvent.click(
      await canvas.findByRole("button", { name: "Continue" }),
    );
    await expect(
      await canvas.findByText("What does this line mean?"),
    ).toBeInTheDocument();
  },
};

export const Loading: Story = {
  render: () => (
    <StudyingRouteView
      client={createStoryLessonClient({
        loadLesson: () => new Promise(() => {}),
      })}
      postId={storyPostId}
    />
  ),
  parameters: {
    docs: {
      description: {
        story: "Payload never settles, holding the route loading state.",
      },
    },
  },
};

export const LoadFailure: Story = {
  render: () => (
    <StudyingRouteView client={createFailingClient()} postId={storyPostId} />
  ),
};

export const AuthRequired: Story = {
  render: () => (
    <StudyingRouteView
      client={createAuthRequiredClient()}
      onConnect={noop}
      postId={storyPostId}
    />
  ),
};

/** Record starts capture at once, with no recording notice in the flow; Stop is the only action until the take ends. */
export const Recording: Story = {
  render: () => (
    <StudyingRouteView
      client={createStoryLessonClient()}
      onExit={noop}
      postId={storyPostId}
      recorder={createStoryRecorder()}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Record" }),
    );
    await expect(
      await canvas.findByRole("button", { name: "Stop" }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("dialog")).toBeNull();
  },
};

/** The take is uploaded and graded; the footer is disabled while it is in flight. */
export const Grading: Story = {
  render: () => (
    <StudyingRouteView
      client={createStoryLessonClient({
        submitAttempt: () => new Promise(() => {}),
      })}
      onExit={noop}
      postId={storyPostId}
      recorder={createStoryRecorder()}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Record" }),
    );
    await userEvent.click(await canvas.findByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(canvas.queryByRole("button", { name: "Stop" })).toBeNull(),
    );
    await expect(
      canvas.getByRole("button", { name: /Checking/ }),
    ).toBeDisabled();
  },
};

/** The server completed the lesson and the streak qualified. */
export const Completion: Story = {
  render: () => (
    <StudyingRouteView
      client={createStoryLessonClient()}
      onExit={noop}
      onStudyAgain={noop}
      postId={storyPostId}
      recorder={createStoryRecorder()}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Injected legacy client that supplies a streak directly. The production v2 results-then-streak sequence reads exact-attempt completion separately and is covered by Flows/Studying/Completion.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Record" }),
    );
    await userEvent.click(await canvas.findByRole("button", { name: "Stop" }));
    // Owner correction: genuine grading feedback remains until explicit Next.
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "I don't know why you left so early",
      }),
    );
    await expect(await canvas.findByText("Correct", { exact: true })).toBeVisible();
    await expect(canvas.queryByText("day streak")).toBeNull();
    await userEvent.click(await canvas.findByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(canvas.getByText("day streak")).toBeInTheDocument(),
    );
  },
};

/** The lesson completed but the daily qualification target was not met. */
export const QualificationNotAchieved: Story = {
  render: () => (
    <StudyingRouteView
      client={createStoryLessonClient({
        submitAttempt: async (input) => {
          const result = storyCorrectAttempt(input);
          if (input.type !== "translation_choice") return result;
          return {
            ...result,
            study_progress: {
              current_streak: 4,
              next_due_at: Math.floor(Date.now() / 1000) + 86_400,
              qualified_today: false,
              study_attempt_count: 2,
              study_correct_count: 1,
              study_target_count: 10,
            },
          };
        },
      })}
      onExit={noop}
      onStudyAgain={noop}
      postId={storyPostId}
      recorder={createStoryRecorder()}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "What production shows today: the results page with accuracy and correct/missed tiles, Continue back to the song and a quiet Study again.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Record" }),
    );
    await userEvent.click(await canvas.findByRole("button", { name: "Stop" }));
    // Feedback must be inspected before explicit Next applies server progress.
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "I don't know why you left so early",
      }),
    );
    await expect(await canvas.findByText("Correct", { exact: true })).toBeVisible();
    await expect(canvasElement.querySelector("[data-activity-results]")).toBeNull();
    await userEvent.click(await canvas.findByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(
        canvasElement.querySelector("[data-activity-results]"),
      ).not.toBeNull(),
    );
    await expect(
      canvas.getByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Study again" }),
    ).toBeInTheDocument();
  },
};
