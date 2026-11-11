import type { RewardWalletOutcome } from "../live/reward-wallet.ts";
import type { WalletSendIntentV1, WalletSendQuoteV1 } from "./contracts.ts";

/** Pure service boundary for the ported Flows/Wallet/Send composition, never an auth store. */
export interface SponsoredSendNetwork {
  chainId: 6343;
  token: string;
  decimals: number;
  symbol: string;
  label: string;
  feeDescription: string;
  explorerTransactionUrl?: (hash: string) => string;
}
export interface WalletSponsoredSendRecord {
  send_id: string;
  persona_id: string;
  status:
    | "reserved"
    | "submitted"
    | "review_required"
    | "confirmed"
    | "cancelled"
    | "reverted"
    | "abandoned";
  chain_id: 6343;
  token_address: string;
  sender_address: string;
  recipient_address: string;
  amount_atomic: string;
  transaction_hash: string | null;
  verification_required: boolean;
  authorization: WalletSendIntentV1 | null;
  /** The existing server intent, not reconstructed from UI state. */
  intent: WalletSendIntentV1;
}
export interface WalletSendDraft {
  accountId: string;
  personaId: string;
  walletAddress: string;
  recipient: string;
  amount: string;
  idempotencyKey: string;
  sendId: string | null;
}
export interface WalletApproval {
  intent: WalletSendIntentV1;
  attemptId: string;
  result: RewardWalletOutcome;
}
export interface RewardTokenTransfer {
  sender: string;
  token: string;
  recipient: string;
  amountAtomic: string;
  chainId: 6343;
}
export interface WalletSponsoredSendData {
  network: SponsoredSendNetwork;
  sender(identity: string): Promise<{ address: string }>;
  tokenBalance(token: string, sender: string): Promise<bigint | undefined>;
  read(identity: string): Promise<WalletSponsoredSendRecord | null>;
  preview(
    recipient: string,
    amount: string | "max",
  ): Promise<WalletSendQuoteV1>;
  reserve(
    identity: string,
    recipient: string,
    amount: string,
    idempotencyKey: string,
    quote: WalletSendQuoteV1,
  ): Promise<WalletSponsoredSendRecord>;
  submit(
    id: string,
    approval: WalletApproval,
  ): Promise<WalletSponsoredSendRecord>;
  reconcile(id: string): Promise<WalletSponsoredSendRecord>;
  cancel(id: string): Promise<WalletSponsoredSendRecord>;
}
export interface SigningWallet {
  restoreAuthorization(): Promise<boolean>;
  approveRecorded(
    record: WalletSponsoredSendRecord,
    action?: "pay" | "cancel",
  ): Promise<WalletApproval>;
  dispose(): void;
}
export interface WalletSponsoredSendDependencies {
  data: WalletSponsoredSendData;
  openWallet(): Promise<SigningWallet>;
  reauthorize(signal: AbortSignal): Promise<boolean>;
  /** MOSS hosts its approval iframe outside this sheet; it must retain pointer/keyboard custody. */
  externalWalletOwnsFocus?: boolean;
  verificationRequired?: (error: unknown) => boolean;
  /** Hosted MOSS owns recipient, amount, Max, fees and its own durable transaction history. */
  hosted?: {
    open(signal: AbortSignal): Promise<RewardWalletOutcome>;
    history(): Promise<void>;
  };
  continuation?: {
    remember(draft: WalletSendDraft): string;
    forget(id: string): void;
  };
  navigate?: (path: string) => void;
  reload?: () => void;
}
export class WalletPortResponseValidationError extends Error {}
export class WalletPortInputError extends Error {}
