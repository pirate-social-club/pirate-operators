import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";
import { expectLearningActivityFrameGeometry } from "../test-support/activity-frame-geometry.ts";
import { ActivityStatusShell } from "./activity-status-shell.tsx";

const meta = {
  title: "Components/Feedback/ActivityStatusShell",
  tags: ["part"],
  component: ActivityStatusShell,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Standard activity page chrome: existing progress header, content-only ErrorState and shared mobile-safe footer.",
      },
    },
  },
} satisfies Meta<typeof ActivityStatusShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StudyEnded: Story = {
  args: {
    title: "This lesson has ended",
    description: "You finished 2 of 4 cards.",
    tone: "blocked",
    exitIcon: "close",
    exitLabel: "Exit study",
    onExit: fn(),
    progressMax: 4,
    progressValue: 2,
    progressTone: "success",
    primaryAction: { label: "New lesson", onClick: fn() },
  },
  play: async ({ canvasElement }) => {
    await expectLearningActivityFrameGeometry(canvasElement);
  },
};

export const Loading: Story = {
  args: {
    title: "Starting karaoke…",
    loading: true,
    exitIcon: "back",
    exitLabel: "Exit karaoke",
    onExit: fn(),
  },
  play: async ({ canvasElement }) => {
    await expectLearningActivityFrameGeometry(canvasElement, { footer: false });
  },
};

export const KaraokeUnknown: Story = {
  args: {
    title: "Couldn't start karaoke",
    description: "Go back and try again in a minute.",
    tone: "blocked",
    exitIcon: "back",
    exitLabel: "Exit karaoke",
    onExit: fn(),
    primaryAction: { label: "Back", onClick: fn() },
  },
};
