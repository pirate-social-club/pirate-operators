import type {
  RewardPayment,
  RewardWalletView,
} from "../../../../packages/rewards/contracts.ts";
import type { RewardWalletOutcome } from "../live/reward-wallet.ts";

/** Lane 7 supplies provider/chain facts; lane 2 owns review and explicit signing. */
export interface WalletSendQuoteV1 {
  schema: "pirate.wallet-send-quote/1";
  quoteId: string;
  chainId: 6343;
  sender: string;
  recipient: string;
  token: string;
  decimals: number;
  amountAtomic: string;
  balanceAtomic: string;
  fee: {
    token: string;
    decimals: number;
    symbol: string;
    reserveAtomic: string;
    estimatedAtomic: string | null;
  };
  expiresAt: number;
  /** Provider-quoted native gas cap in wei, forwarded unchanged to explicit MOSS approval. */
  maxGasAllowanceWei: string;
}
export interface WalletSendIntentV1 {
  schema: "pirate.wallet-send-intent/1";
  quote: WalletSendQuoteV1;
  /** Immutable sender/recipient/amount and nonce, using the existing account guard. */
  payment: RewardPayment;
}
export interface WalletSendAdapterV1 {
  schema: "pirate.wallet-send-adapter/1";
  /** Durable, authenticated account state, including unresolved sends after reload. */
  current(view: RewardWalletView): Promise<WalletSendIntentV1 | null>;
  quote(
    view: RewardWalletView,
    request: { recipient: string; amountAtomic: string | "max" },
  ): Promise<WalletSendQuoteV1>;
  /** Idempotent by quoteId; refuse if this account has any unresolved send. */
  prepare(quote: WalletSendQuoteV1): Promise<WalletSendIntentV1>;
  /** Persist attempt before opening MOSS; retry must retain this exact guard nonce. */
  begin(
    intentId: string,
    attemptId: string,
    action?: "pay" | "cancel",
  ): Promise<WalletSendIntentV1>;
  outcome(
    intentId: string,
    attemptId: string,
    result: RewardWalletOutcome,
  ): Promise<WalletSendIntentV1>;
  /** Canonical guard + exact transfer proof only; never trust an SDK hash alone. */
  reconcile(intentId: string): Promise<WalletSendIntentV1>;
  /** Only a never-dispatched prepared intent can be cancelled without a wallet call. */
  cancel(intentId: string): Promise<WalletSendIntentV1>;
}

export type { RewardCloseReadinessV1 } from "../../../../packages/rewards/close-readiness.ts";
