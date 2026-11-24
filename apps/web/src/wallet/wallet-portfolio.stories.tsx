import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { LiveRewardWallet } from "../live/rewards.tsx";
import {
  createWalletStoryData,
  type WalletStoryScenario,
} from "./wallet-story-fixtures.ts";

function WalletRouteFixture(props: { scenario: WalletStoryScenario }) {
  return (
    <main class="min-h-screen bg-background p-6 text-foreground">
      <LiveRewardWallet
        csrf="catalog-session"
        onExit={fn()}
        data={createWalletStoryData(props.scenario)}
      />
    </main>
  );
}

const meta = {
  title: "Wallet/Screens/Portfolio",
  tags: ["screen"],
  component: WalletRouteFixture,
  args: { scenario: "ready" },
  render: (args) => <WalletRouteFixture {...args} />,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Renders the real LiveRewardWallet route and its controller. The RewardsData port supplies production-shaped wallet data; no MOSS connection, balance request, signing, claim, send or chain operation runs. Loading, load failure, zero balance and Receive exercise states the production data contract can actually represent.",
      },
    },
  },
} satisfies Meta<typeof WalletRouteFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const Loading: Story = {
  args: { scenario: "loading" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("status", { name: "" }),
    ).toHaveTextContent("Loading wallets…");
  },
};

export const LoadFailure: Story = {
  args: { scenario: "failure" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("alert"),
    ).toHaveTextContent("Your wallets could not be loaded.");
    await expect(
      within(canvasElement).getByRole("button", { name: "Try again" }),
    ).toBeEnabled();
  },
};

export const ZeroBalance: Story = { args: { scenario: "zero" } };

export const Receive: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: /^Receive$/ }),
    );
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole("dialog"),
    ).toBeVisible();
  },
};
