import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { WalletPortfolio } from "./established/wallet-portfolio.tsx";
import type { WalletHubChainSection } from "./established/wallet-hub.types.ts";
import type { PersonaWallet } from "./established/wallet-portfolio-model.ts";

const wallet: PersonaWallet = {
  personaId: "catalog-preview",
  displayName: "Catalog wallet",
  publicHandle: null,
  avatarSrc: null,
  address: "0x1111111111111111111111111111111111111111",
};

function PortfolioFixture(props: {
  loading: boolean;
  unavailable: boolean;
  empty: boolean;
  onRefresh: () => void;
}) {
  const sections = (): WalletHubChainSection[] => [
    {
      chainId: "megaeth",
      title: "MegaETH testnet",
      availability: "ready",
      walletAddress: wallet.address,
      balancesUnavailable: props.unavailable,
      tokens: [
        {
          id: "catalog-usdc",
          symbol: "USDC",
          name: "Preview USDC",
          balance: props.unavailable ? undefined : "12.50",
          fiatValue: props.unavailable ? undefined : "$12.50",
        },
      ],
    },
  ];
  return (
    <main class="min-h-screen bg-background p-6 text-foreground">
      <p role="note" class="mx-auto mb-4 max-w-[640px] text-muted-foreground">
        UI fixture balances and a public dummy address. No wallet is connected.
      </p>
      <WalletPortfolio
        chainSections={sections()}
        balancesLoading={props.loading}
        totalBalanceUsd={props.unavailable ? null : "$12.50"}
        wallets={props.empty ? [] : [wallet]}
        selectedPersonaId={props.empty ? undefined : wallet.personaId}
        networkMode="testnet"
        onRefresh={props.onRefresh}
        onSelect={fn()}
        onChangeProfile={fn()}
      />
    </main>
  );
}

const meta = {
  title: "Screens/Wallet/Portfolio",
  component: PortfolioFixture,
  args: { loading: false, unavailable: false, empty: false, onRefresh: fn() },
  render: (args) => <PortfolioFixture {...args} />,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Uses the WalletPortfolio mounted by the live rewards page and its real ReceiveSheet. Balances and account identity are presentation fixtures. No MOSS connection, balance request, signing, claim, send or chain operation runs. Receive interaction opens only the local sheet.",
      },
    },
  },
} satisfies Meta<typeof PortfolioFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const Loading: Story = {
  args: { loading: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Refresh balances" }),
    ).toBeDisabled();
  },
};

export const BalancesUnavailable: Story = { args: { unavailable: true } };

export const Empty: Story = {
  args: { empty: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("No active profile wallets yet."),
    ).toBeVisible();
  },
};

export const Receive: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /^Receive$/ }),
    );
    // The production sheet portals outside the canvas.
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole("dialog"),
    ).toBeVisible();
  },
};
