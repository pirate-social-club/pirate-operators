import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { fiveChainSections, sharedWalletAddress } from "./wallet-flow-fixtures";
import { WalletReceiveSheet } from "./wallet-receive-sheet";
import type { WalletReceiveSheetProps } from "./wallet-receive-sheet.types";

const meta = {
  title: "Parts/Wallet/ReceiveSheet",
  component: WalletReceiveSheet,
  args: { chainSections: fiveChainSections, onOpenChange: () => undefined, open: true, walletAddress: sharedWalletAddress },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WalletReceiveSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

function StoryRender(props: WalletReceiveSheetProps) {
  const [open, setOpen] = createSignal(true);
  return <div class="min-h-screen bg-background p-6"><WalletReceiveSheet {...props} onOpenChange={setOpen} open={open()} /></div>;
}

/** Paper 204: on desktop Receive is a 480px dialog showing the full address. */
export const DefaultDesktop: Story = {
  render: (args) => <StoryRender {...args} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", {}, { timeout: 5000 });
    await waitFor(() => expect(Math.round(dialog.getBoundingClientRect().width)).toBe(480));
    // The address is never cut in the middle.
    await expect(within(dialog).getByText(sharedWalletAddress)).toBeVisible();
    await expect(within(dialog).getByRole("button", { name: "Copy address" })).toBeVisible();
    const done = within(dialog).getByRole("button", { name: "Done" });
    await expect(Math.abs(done.getBoundingClientRect().width - (done.parentElement?.getBoundingClientRect().width ?? 0))).toBeLessThanOrEqual(1);
  },
};
/** Paper 202: on a phone Receive is a bottom sheet with the same content. */
export const DefaultMobile: Story = {
  args: { forceMobile: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: (args) => <StoryRender {...args} />,
  play: async ({ canvasElement }) => {
    const view = canvasElement.ownerDocument.defaultView!;
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {}, { timeout: 5000 });
    // The sheet slides up from the bottom edge; measure once it has landed.
    await waitFor(() => expect(Math.abs(dialog.getBoundingClientRect().bottom - view.innerHeight)).toBeLessThanOrEqual(1), { timeout: 3000 });
    await expect(within(dialog).getByText(sharedWalletAddress)).toBeVisible();
  },
};
export const ChainSwitched: Story = {
  render: (args) => <StoryRender {...args} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Receive" }, { timeout: 5000 });
    await expect(within(dialog).getByText("Base Sepolia address")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /Story Aeneid/ }));
    await expect(within(dialog).getByText("Story Aeneid address")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /Base Sepolia/ }));
    await expect(within(dialog).getByText("Base Sepolia address")).toBeInTheDocument();
  },
};
export const AllChainsSameAddress: Story = { render: (args) => <StoryRender {...args} /> };
export const EmptyNoWallet: Story = { args: { chainSections: fiveChainSections.map((section) => ({ ...section, walletAddress: null })), walletAddress: null }, render: (args) => <StoryRender {...args} /> };

export const BaseUnavailable: Story = {
  args: { chainSections: fiveChainSections.map(section => section.chainId === "base" ? { ...section, availability: "later" } : section) },
  render: args => <StoryRender {...args} />,
  play: async ({ canvasElement }) => {
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Receive" });
    const canvas = within(dialog);
    await expect(canvas.getByText("Choose a network to see its receive address.")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Copy address" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: /Story Aeneid/ }));
    await expect(canvas.getByText("Story Aeneid address")).toBeVisible();
    await expect(canvas.getByText(sharedWalletAddress)).toBeVisible();
  },
};
