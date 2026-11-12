import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { WalletPortfolio } from "./wallet-portfolio.tsx";
import { walletAssetSections, type WalletNetworkMode } from "./wallet-network-catalog.ts";
import type { PersonaWallet } from "./wallet-portfolio-model.ts";

const portfolioWallets: readonly PersonaWallet[] = [
  { personaId: "persona_harbor", displayName: "Harbor", publicHandle: "harbor.pirate", avatarSrc: null, address: "0x1111111111111111111111111111111111111111" },
  { personaId: "persona_night", displayName: "Night Shift", publicHandle: null, avatarSrc: null, address: "0x2222222222222222222222222222222222222222" },
];
/**
 * Production by default: no network switch, mainnet only. `staging` adds the
 * switch the staging host offers; `testnet` is a staging host already on it.
 */
function PortfolioStory(props: { empty?: boolean; loading?: boolean; partial?: boolean; staging?: boolean; testnet?: boolean }) {
  const [selected, setSelected] = createSignal(portfolioWallets[0]!.personaId);
  const [mode, setMode] = createSignal<WalletNetworkMode>(props.testnet ? "testnet" : "mainnet");
  const sections = () => walletAssetSections(portfolioWallets.find(wallet => wallet.personaId === selected())!.address, mode()).map(section => ({
    ...section,
    balancesUnavailable: Boolean(props.loading || props.partial),
    tokens: section.tokens.map(token => ({ ...token, balance: props.loading ? "Loading…" : props.partial && section.chainId === "base" ? "Unavailable" : token.symbol === "USDC" ? selected() === "persona_harbor" ? "42.36" : "128.50" : token.symbol === "$DATA" ? "18.20" : "0.1267" })),
  }));
  return <div class="p-5"><WalletPortfolio wallets={props.empty ? [] : portfolioWallets} selectedPersonaId={selected()} onSelect={setSelected} onChangeProfile={() => setSelected(selected() === "persona_harbor" ? "persona_night" : "persona_harbor")} chainSections={sections()} networkMode={mode()} onNetworkModeChange={props.staging || props.testnet ? setMode : undefined} balancesLoading={props.loading} onRefresh={() => {}} /></div>;
}
const meta = { title: "Screens/Wallet/Portfolio", parameters: { layout: "fullscreen", a11y: { test: "error" } } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Desktop: Story = {
  render: () => <PortfolioStory />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("group", { name: "Wallet networks" })).toBeNull();
    await expect(within(canvasElement).getByRole("button", { name: "Refresh balances" })).toBeEnabled();
    await expect(within(canvasElement).queryByRole("button", { name: "Switch profile" })).toBeNull();
  },
};
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } }, render: () => <PortfolioStory /> };
export const Empty: Story = { render: () => <PortfolioStory empty /> };
export const ReceiveSelectedProfile: Story = {
  render: () => <PortfolioStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: /Night Shift/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Receive" }));
    const dialog = await page.findByRole("dialog", { name: "Receive" });
    await expect(dialog).toHaveTextContent("0x22222222");
    await expect(dialog).not.toHaveTextContent("0x11111111");
    await expect(dialog).not.toHaveTextContent("$0.00");
  },
};

export const LoadingBalances: Story = { render: () => <PortfolioStory loading /> };
export const PartialBalances: Story = { render: () => <PortfolioStory partial /> };
export const Testnet: Story = { render: () => <PortfolioStory testnet /> };
/** Staging host: balances follow the selected profile, and the switch moves to Testnet. */
export const PersonaBalances: Story = {
  render: () => <PortfolioStory staging />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("42.36")).toHaveLength(2);
    await userEvent.click(canvas.getByRole("button", { name: /Night Shift/ }));
    await expect(canvas.getAllByText("128.50")).toHaveLength(2);
    await expect(canvas.queryByText("42.36")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Testnet" }));
    await expect(canvas.getByText("Base Sepolia")).toBeVisible();
    await expect(canvas.queryByText("Testnet tokens have no monetary value.")).toBeNull();
  },
};
