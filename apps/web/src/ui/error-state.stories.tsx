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
    error: true,
    primaryAction: { label: "Try again", onClick: fn() },
  },
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Content-only error state. Route shells own the page header, exit control and footer actions; inline pages such as Wallet may render the actions here.",
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
