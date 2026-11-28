// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-route-view.stories.tsx.
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { expectLearningActivityFrameGeometry } from "../test-support/activity-frame-geometry.ts";

import { StudyingRouteView } from "./studying-route-view";
import { StudyLoading, StudyScreen } from "./screen.tsx";
import {
  createAuthRequiredClient,
  createRecoveringLoadClient,
  createStoryLessonClient,
  createStoryRecorder,
  storyPostId,
} from "./studying-story-fixtures";
import {
  createMountedStudyFixture,
  mountedStudyAccount,
  mountedStudyPostId,
  type MountedStudyFixtureOptions,
} from "./studying-mounted-story-fixtures.ts";

const meta = {
  title: "Studying/Screens/Route",
  // The tier lives in metadata so the sidebar can group feature-first.
  tags: ["screen"],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The studying screen and its lower-level route seam. Primary lesson, completion and recovery stories mount " +
          "StudyScreen through the production operator adapter and a server-shaped spoken lesson fixture; narrow " +
          "loading, auth and in-flight seam states keep an injected route client. Recovery journeys continue to a " +
          "card; their companion warning stories stop at the blocking state so the browser audit captures it. No " +
          "network or microphone is used.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type Canvas = ReturnType<typeof within>;

const noop = () => {};

function mountedStudy(options: MountedStudyFixtureOptions = {}) {
  return () => {
    const fixture = createMountedStudyFixture(options);
    return (
      <StudyScreen
        account={mountedStudyAccount}
        client={fixture.client}
        lessonId={fixture.initialLessonId}
        onExit={noop}
        postId={mountedStudyPostId}
        recorder={createStoryRecorder()}
      />
    );
  };
}

async function submitSpoken(canvas: Canvas) {
  await userEvent.click(
    await canvas.findByRole("button", { name: "Record" }),
  );
  await userEvent.click(await canvas.findByRole("button", { name: "Stop" }));
}

async function expectResults(canvasElement: HTMLElement, score: string) {
  await waitFor(() =>
    expect(
      canvasElement.querySelector("[data-activity-results]"),
    ).not.toBeNull(),
  );
  const results = canvasElement.querySelector("[data-activity-results]");
  await expect(results).toHaveTextContent(score);
  await expect(results).toHaveTextContent("Correct");
  await expect(results).toHaveTextContent("Missed");
  expect(canvasElement.textContent).not.toContain("day streak");
  expect(canvasElement.textContent).not.toContain("$MOON");
}

async function expectRecordingOutcomeUnknownWarning(
  canvas: Canvas,
  canvasElement: HTMLElement,
) {
  await expect(
    await canvas.findByRole("heading", { name: "Couldn't get your result" }),
  ).toBeInTheDocument();
  await expect(
    canvas.getByText("This lesson can't continue. Start a new one."),
  ).toBeInTheDocument();
  await expect(canvas.getByRole("alert")).toHaveTextContent(
    "Couldn't get your result",
  );
  await expectLearningActivityFrameGeometry(canvasElement);
}

async function reachRecordingOutcomeUnknownWarning(
  canvas: Canvas,
  canvasElement: HTMLElement,
) {
  await submitSpoken(canvas);
  await expectRecordingOutcomeUnknownWarning(canvas, canvasElement);
}

async function expectExpiredLessonWarning(
  canvas: Canvas,
  canvasElement: HTMLElement,
) {
  await expect(
    await canvas.findByRole("heading", { name: "This lesson has ended" }),
  ).toBeInTheDocument();
  await expect(
    canvas.getByText("You finished 1 of 4 cards."),
  ).toBeInTheDocument();
  await expect(canvas.queryByRole("button", { name: "Record" })).toBeNull();
  await expectLearningActivityFrameGeometry(canvasElement);
}

async function reachExpiredLessonWarning(
  canvas: Canvas,
  canvasElement: HTMLElement,
) {
  await canvas.findByText("La luna sigue brillando sobre el mar");
  await submitSpoken(canvas);
  await expectExpiredLessonWarning(canvas, canvasElement);
}

async function expectLoadFailureWarning(
  canvas: Canvas,
  canvasElement: HTMLElement,
) {
  await expect(
    await canvas.findByRole("heading", { name: "Study unavailable" }),
  ).toBeInTheDocument();
  await expect(
    canvas.getByText("Connection lost while loading the lesson."),
  ).toBeInTheDocument();
  await expect(
    canvas.getByRole("button", { name: "Try Again" }),
  ).toBeEnabled();
  await expect(
    canvas.getByRole("button", { name: "Go Home" }),
  ).toBeEnabled();
  await expectLearningActivityFrameGeometry(canvasElement);
}

function recoveringLoadStudy() {
  return () => {
    const client = createRecoveringLoadClient();
    return (
      <StudyingRouteView
        client={client}
        onExit={noop}
        postId={storyPostId}
        recorder={createStoryRecorder()}
      />
    );
  };
}

export const LessonFlow: Story = {
  render: mountedStudy(),
  parameters: {
    docs: {
      description: {
        story:
          "Production-shaped spoken lesson through the mounted StudyScreen: four server-owned cards, one first-pass miss returning later, and completion at the real 3/4 score. There is no translation card, reward badge or streak page.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await submitSpoken(canvas);
    await canvas.findByText("La luna sigue brillando sobre el mar");

    await submitSpoken(canvas);
    await canvas.findByText("Incorrect");
    await userEvent.click(
      await canvas.findByRole("button", { name: "Continue" }),
    );
    await canvas.findByText("Cada palabra vuelve a su lugar");

    await submitSpoken(canvas);
    await canvas.findByText("Cantamos hasta ver salir el sol");

    await submitSpoken(canvas);
    await canvas.findByText("La luna sigue brillando sobre el mar");

    await submitSpoken(canvas);
    await expectResults(canvasElement, "3/4");
    await expect(
      canvas.getByRole("button", { name: "Continue" }),
    ).toBeEnabled();
    await expect(
      canvas.getByRole("button", { name: "Study again" }),
    ).toBeEnabled();
  },
};

export const RecordingOutcomeUnknown: Story = {
  render: mountedStudy({ unresolvedRecording: true }),
  parameters: {
    docs: {
      description: {
        story:
          "The upload outcome is unknown after the provider may have accepted it. The mounted screen blocks the old lesson, then New lesson reaches a fresh spoken card.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await reachRecordingOutcomeUnknownWarning(canvas, canvasElement);

    await userEvent.click(
      canvas.getByRole("button", { name: "New lesson" }),
    );
    await expect(
      await canvas.findByRole("button", { name: "Record" }),
    ).toBeEnabled();
    await expect(
      canvas.queryByRole("heading", { name: "Couldn't get your result" }),
    ).toBeNull();
    await canvas.findByText("Yo no sé por qué te fuiste tan temprano");
  },
};

export const RecordingOutcomeUnknownWarning: Story = {
  name: "Recording outcome unknown warning",
  render: mountedStudy({ unresolvedRecording: true }),
  parameters: {
    docs: {
      description: {
        story:
          "Audit-facing companion to the recovery journey. It submits one uncertain upload and stops on the blocking warning instead of advancing to the replacement card.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await reachRecordingOutcomeUnknownWarning(within(canvasElement), canvasElement);
  },
};

export const ExpiredLesson: Story = {
  name: "Lesson ended",
  render: mountedStudy({
    closeOnOpen: true,
    resolvedBefore: 1,
    firstPassCorrectBefore: 1,
  }),
  parameters: {
    docs: {
      description: {
        story:
          "The real in-flight closure race: the learner opens a lesson with one card finished, submits after its legacy deadline closes it, sees the ended warning, then starts a fresh spoken lesson.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await reachExpiredLessonWarning(canvas, canvasElement);

    await userEvent.click(
      canvas.getByRole("button", { name: "New lesson" }),
    );
    await expect(
      await canvas.findByRole("button", { name: "Record" }),
    ).toBeEnabled();
    await expect(
      canvas.queryByRole("heading", { name: "This lesson has ended" }),
    ).toBeNull();
    await canvas.findByText("Yo no sé por qué te fuiste tan temprano");
  },
};

export const ExpiredLessonWarning: Story = {
  name: "Lesson ended warning",
  render: mountedStudy({
    closeOnOpen: true,
    resolvedBefore: 1,
    firstPassCorrectBefore: 1,
  }),
  parameters: {
    docs: {
      description: {
        story:
          "Audit-facing companion to the closure race. It reaches the terminal warning through an actual submission and stops there so screenshot and accessibility evidence cover the blocked lesson.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await reachExpiredLessonWarning(within(canvasElement), canvasElement);
  },
};

export const MissedAttempts: Story = {
  render: mountedStudy({ resolvedBefore: 1, firstPassCorrectBefore: 1 }),
  parameters: {
    docs: {
      description: {
        story:
          "A spoken miss is spent for this appearance. Continue takes the learner to the server's next spoken card; the missed line returns later in the same lesson.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("La luna sigue brillando sobre el mar");
    await submitSpoken(canvas);
    await expect(await canvas.findByText("Incorrect")).toBeInTheDocument();
    await userEvent.click(
      await canvas.findByRole("button", { name: "Continue" }),
    );
    await canvas.findByText("Cada palabra vuelve a su lugar");
    await expect(canvas.queryByText("What does this line mean?")).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Record" }),
    ).toBeEnabled();
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
    await expectLearningActivityFrameGeometry(canvasElement, {
      header: false,
      footer: false,
    });
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
  render: recoveringLoadStudy(),
  parameters: {
    docs: {
      description: {
        story:
          "The first load fails transiently; the explicit retry must return the learner to the spoken card rather than only prove that the error button renders.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expectLoadFailureWarning(canvas, canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Try Again" }),
    );
    await expect(
      await canvas.findByRole("button", { name: "Record" }),
    ).toBeEnabled();
    await expect(canvas.queryByText("Study unavailable")).toBeNull();
    await canvas.findByText("Yo no sé por qué te fuiste tan temprano");
  },
};

export const LoadFailureWarning: Story = {
  name: "Load failure warning",
  render: recoveringLoadStudy(),
  parameters: {
    docs: {
      description: {
        story:
          "Audit-facing companion to the retry journey. It stops on the initial load failure so screenshot and accessibility evidence cover the warning before recovery.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expectLoadFailureWarning(within(canvasElement), canvasElement);
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

/** The mounted screen completes through the operator results surface. */
export const Completion: Story = {
  render: mountedStudy({ resolvedBefore: 3, firstPassCorrectBefore: 2 }),
  parameters: {
    docs: {
      description: {
        story:
          "Final spoken answer through the real mounted completion path. The operator has no exact-lesson earned-day capability, so the results score is terminal: no streak page, qualification fixture, reward badge or translation card.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Cantamos hasta ver salir el sol");
    await submitSpoken(canvas);
    await expectResults(canvasElement, "3/4");
    await expect(
      canvas.getByRole("button", { name: "Continue" }),
    ).toBeEnabled();
    await expect(
      canvas.getByRole("button", { name: "Study again" }),
    ).toBeEnabled();
  },
};
