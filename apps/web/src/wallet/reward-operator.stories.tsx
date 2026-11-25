import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { LiveRewardOperator } from "../live/reward-operator.tsx";
import {
  createRewardOperatorStoryData,
  type RewardOperatorStoryScenario,
} from "./reward-operator-story-fixtures.ts";

function RewardOperatorRouteFixture(props: { scenario: RewardOperatorStoryScenario }) {
  return (
    <div class="min-h-screen bg-background text-foreground">
      <LiveRewardOperator
        csrf="catalog-session"
        onExit={fn()}
        data={createRewardOperatorStoryData(props.scenario)}
        sign={async () => ({ outcome: "approved", transactionHash: null })}
      />
    </div>
  );
}

const meta = {
  title: "Wallet/Screens/Reward operator",
  tags: ["screen"],
  component: RewardOperatorRouteFixture,
  args: { scenario: "ready" },
  render: (args) => <RewardOperatorRouteFixture {...args} />,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Renders the real LiveRewardOperator route and its controller. The RewardsData port supplies production-shaped operator data; no chain read, wallet signature, payment dispatch or reward write runs. Stories cover the ready operational surface, loading and service failure, plus the guarded payment-review transition.",
      },
    },
  },
} satisfies Meta<typeof RewardOperatorRouteFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Reward payments" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "Payout inventory" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "Attach purchased tickets" }),
    ).toBeVisible();
  },
};

export const Loading: Story = {
  args: { scenario: "loading" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("status"),
    ).toHaveTextContent("Loading reward operations…");
  },
};

export const LoadFailure: Story = {
  args: { scenario: "failure" },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("status"),
    ).toHaveTextContent("Reward service unavailable.");
    await expect(
      within(canvasElement).getByRole("button", { name: "Refresh records" }),
    ).toBeEnabled();
  },
};

export const PaymentReview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Review payment" }),
    );
    await expect(
      await canvas.findByRole("heading", { name: "Review payment" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Approve in wallet" }),
    ).toBeEnabled();
  },
};
