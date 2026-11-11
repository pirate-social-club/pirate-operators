import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type { WalletSponsoredSendRecord } from "../../api/wallet-sponsored-send.ts";
import { BASE_SEPOLIA_SPONSORED_SEND } from "../../api/sponsored-send-network.ts";
import { WalletSponsoredSendSheet, type WalletSponsoredSendDependencies } from "./wallet-sponsored-send-sheet.tsx";

const sender = "0x1111111111111111111111111111111111111111";
const recipient = "0x9f2c4b7e1d3a5c6b8e0f2a4c6e8b0d2f4a6c3a1c";
const token = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

const confirmed: WalletSponsoredSendRecord = {
  object: "wallet_sponsored_send", send_id: "wallet_send_story", persona_id: "persona_story",
  status: "confirmed", chain_id: 84532, token_address: token, sender_address: sender,
  recipient_address: recipient, amount_atomic: "5000000",
  transaction_hash: "0x5be1c0de5be1c0de5be1c0de5be1c0de5be1c0de5be1c0de5be1c0de5be1c0de",
  authorization: null,
  verification_required: false,
};

/**
 * Story doubles at the sheet's dependency seam: a 12.40 USDC balance and an
 * already-authorized wallet. Reserve and sign record their calls and never
 * settle, so no story reaches the network or a wallet.
 */
function storyDependencies(existing: WalletSponsoredSendRecord | null = null): WalletSponsoredSendDependencies {
  return {
    data: {
      network: BASE_SEPOLIA_SPONSORED_SEND,
      sender: async () => ({ address: sender, walletIndex: 0 }),
      tokenBalance: async () => 12_400_000n,
      read: async () => existing,
      reserve: fn(() => new Promise<WalletSponsoredSendRecord>(() => {})),
      submit: fn(() => new Promise<WalletSponsoredSendRecord>(() => {})),
      issueVerificationIntent: fn(async () => "wallet-send_story"),
    },
    openWallet: async () => ({
      restoreAuthorization: async () => true,
      signSponsoredRequest: fn(() => new Promise<string>(() => {})),
      dispose: () => {},
    }),
  };
}

const meta = {
  title: "Flows/Wallet/Send",
  component: WalletSponsoredSendSheet,
  args: {
    accountId: "account_story",
    personaId: "persona_story",
    walletAddress: sender,
    onClose: fn(),
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The Wallet's USDC send (testnet), as Paper 108-115 draw it: details, review, then the recorded send. Stories run against doubles at the sheet's dependency seam, so nothing is reserved, signed or submitted.",
      },
    },
  },
  render: args => <div class="min-h-screen bg-background p-6"><WalletSponsoredSendSheet {...args} /></div>,
} satisfies Meta<typeof WalletSponsoredSendSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

const phone = { globals: { viewport: { value: "mobile1", isRotated: false } } } as const;

async function openSheet(canvasElement: HTMLElement) {
  const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Send USDC" }, { timeout: 5000 });
  await within(dialog).findByText("Wallet balance: 12.4 USDC");
  return dialog;
}

async function fillDetails(dialog: HTMLElement) {
  const sheet = within(dialog);
  await userEvent.type(sheet.getByLabelText("Send to"), recipient);
  const amount = sheet.getByLabelText("Amount (USDC)");
  await userEvent.clear(amount);
  await userEvent.type(amount, "5");
}

/** Paper 108/110: who to send to and how much, with the balance shown. */
export const Details: Story = {
  args: { dependencies: storyDependencies() },
  play: async ({ canvasElement }) => {
    const dialog = await openSheet(canvasElement);
    const sheet = within(dialog);
    await expect(sheet.getByLabelText("Send to")).toHaveValue("");
    // The amount starts at the whole balance.
    await expect(sheet.getByLabelText("Amount (USDC)")).toHaveValue("12.4");
    await expect(sheet.getByRole("button", { name: "Continue" })).toBeEnabled();
  },
};

/** The same sheet from the bottom edge on a phone. */
export const DetailsMobile: Story = {
  ...phone,
  args: { dependencies: storyDependencies() },
  play: async ({ canvasElement }) => {
    const view = canvasElement.ownerDocument.defaultView!;
    const dialog = await openSheet(canvasElement);
    await waitFor(() => expect(Math.abs(dialog.getBoundingClientRect().bottom - view.innerHeight)).toBeLessThanOrEqual(1), { timeout: 3000 });
  },
};

/** An address that cannot receive is named before anything is reviewed. */
export const DetailsInvalidRecipient: Story = {
  args: { dependencies: storyDependencies() },
  play: async ({ canvasElement }) => {
    const dialog = await openSheet(canvasElement);
    const sheet = within(dialog);
    await userEvent.type(sheet.getByLabelText("Send to"), "0x123");
    await userEvent.click(sheet.getByRole("button", { name: "Continue" }));
    await expect(await sheet.findByRole("alert")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Continue" })).toBeVisible();
  },
};

const reviewDependencies = storyDependencies();

/** Paper 111/113: the send to review before it is authorized. */
export const Review: Story = {
  args: { dependencies: reviewDependencies },
  play: async ({ canvasElement }) => {
    const dialog = await openSheet(canvasElement);
    const sheet = within(dialog);
    await fillDetails(dialog);
    await userEvent.click(sheet.getByRole("button", { name: "Continue" }));
    await expect(await sheet.findByText("Covered by Pirate")).toBeVisible();
    await expect(sheet.getByText("5 USDC")).toBeVisible();
    await expect(sheet.getByText(recipient)).toBeVisible();
    await expect(sheet.getByText(sender)).toBeVisible();
    await expect(sheet.getByText("Base Sepolia")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Authorize send" })).toBeEnabled();
    // Change details goes back with the form as it was.
    await userEvent.click(sheet.getByRole("button", { name: "Change details" }));
    await expect(await sheet.findByLabelText("Amount (USDC)")).toHaveValue("5");
    await expect(reviewDependencies.data.reserve).not.toHaveBeenCalled();
  },
};

/** Paper 114/115: the recorded send, confirmed, with a link to the transfer. */
export const Sent: Story = {
  args: { dependencies: storyDependencies(confirmed) },
  play: async ({ canvasElement, args }) => {
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Send USDC" }, { timeout: 5000 });
    const sheet = within(dialog);
    await expect(await sheet.findByText("This send is confirmed. The USDC arrived at the recipient.")).toBeVisible();
    await expect(sheet.getByText("Recorded amount: 5 USDC")).toBeVisible();
    await expect(sheet.getByRole("link", { name: "View transfer" })).toHaveAttribute("href", `https://sepolia.basescan.org/tx/${confirmed.transaction_hash}`);
    await expect(sheet.getByRole("button", { name: "New send" })).toBeVisible();
    // The footer's Close, beside the dialog's own close mark.
    const close = sheet.getAllByRole("button", { name: "Close" }).find(button => button.textContent?.trim() === "Close");
    if (close === undefined) throw new Error("Expected the footer Close button");
    await userEvent.click(close);
    await expect(args.onClose).toHaveBeenCalled();
  },
};

/** A recorded send stays unsigned while current Palm evidence is missing. */
export const PalmRequired: Story = {
  args: { dependencies: storyDependencies({ ...confirmed, status: "reserved", transaction_hash: null, verification_required: true }) },
  play: async ({ canvasElement, args }) => {
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Send USDC" });
    const sheet = within(dialog);
    await expect(await sheet.findByRole("button", { name: "Verify palm" })).toBeVisible();
    await expect(sheet.queryByRole("button", { name: "Authorize recorded send" })).not.toBeInTheDocument();
    await expect(args.dependencies?.data.reserve).not.toHaveBeenCalled();
    await expect(args.dependencies?.data.submit).not.toHaveBeenCalled();
  },
};
