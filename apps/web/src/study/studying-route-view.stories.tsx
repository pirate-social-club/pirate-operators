// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-route-view.stories.tsx.
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { expectLearningActivityFrameGeometry } from "../test-support/activity-frame-geometry.ts";

import { StudyingRouteView } from "./studying-route-view";
import { StudyLoading } from "./screen.tsx";
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
  title: "Studying/Screens/Route",
  // The tier lives in metadata so the sidebar can group feature-first.
  tags: ["screen"],
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
      await canvas.findByRole("button", { name: "New lesson" }),
    ).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Exit study" })).toBeEnabled();
    await expect(
      canvas.getByRole("heading", { name: "Couldn't get your result" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByText("This lesson can't continue. Start a new one."),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Couldn't get your result",
    );
    await expect(
      canvas.queryByRole("button", { name: "Recording paused" }),
    ).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Leave Study" })).toBeNull();
    await expectLearningActivityFrameGeometry(canvasElement);
  },
};

export const ExpiredLesson: Story = {
  name: "Lesson ended",
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
      await canvas.findByRole("heading", { name: "This lesson has ended" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByText("You finished 2 of 4 cards."),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Record" })).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "New lesson" }),
    ).toBeEnabled();
    await expectLearningActivityFrameGeometry(canvasElement);
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
  play: async ({ canvasElement }) => {
    await expectLearningActivityFrameGeometry(canvasElement, { header: false, footer: false });
  },
};

export const MountedLoading: Story = {
  name: "Mounted loading",
  render: () => (
    <main aria-label="Study loading">
      <h1 class="sr-only">Study loading</h1>
      <StudyLoading onExit={noop} />
    </main>
  ),
  play: async ({ canvasElement }) => {
    await expectLearningActivityFrameGeometry(canvasElement, { footer: false });
  },
};

export const LoadFailure: Story = {
  render: () => (
    <StudyingRouteView client={createFailingClient()} onExit={noop} postId={storyPostId} />
  ),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("button", { name: "Try Again" });
    await expectLearningActivityFrameGeometry(canvasElement);
  },
};

export const AuthRequired: Story = {
  render: () => (
    <StudyingRouteView
      client={createAuthRequiredClient()}
      onConnect={noop}
      onExit={noop}
      postId={storyPostId}
    />
  ),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("button", { name: "Sign in" });
    await expectLearningActivityFrameGeometry(canvasElement);
  },
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
