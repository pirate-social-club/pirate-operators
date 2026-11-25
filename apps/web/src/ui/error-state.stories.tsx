import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { fn } from "storybook/test";
import { ErrorState } from "./error-state.tsx";

const meta = {
  title: "Components/Feedback/ErrorState",
  tags: ["part"],
  component: ErrorState,
  args: {
    title: "Something went wrong",
    description: "The requested change could not be completed.",
    tone: "retryable",
    primaryAction: { label: "Try again", onClick: fn() },
  },
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Locked error-state composite. Copy says what happened, distinguishes blocked from resumable, and ranks recovery before exit. Paused is reserved for resumable states; a disabled button is never used as a status message. The route X is optional; callers do not add a second exit button.",
      },
    },
  },
} satisfies Meta<typeof ErrorState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Retryable: Story = {};

export const Blocked: Story = {
  args: {
    title: "Sign in required",
    description: "Sign in again to continue.",
    tone: "blocked",
    primaryAction: { label: "Sign in again", href: "/wallet" },
  },
};

export const Resumable: Story = {
  args: {
    title: "Recording paused",
    description: "Your recording is saved. Resume when you are ready.",
    tone: "resumable",
    status: "Paused for this session.",
    primaryAction: { label: "Resume", onClick: fn() },
    secondaryAction: { label: "Leave", onClick: fn() },
  },
};

export const WithExit: Story = {
  args: {
    title: "Couldn't get your result",
    description: "This lesson can't continue. Start a new one.",
    tone: "blocked",
    primaryAction: { label: "New lesson", onClick: fn() },
    onExit: fn(),
    exitLabel: "Exit study",
  },
};
