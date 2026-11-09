/** Owned pilot API: public learning results remain separate from private reward obligations. */
export interface RewardsProfile {
  schema: "pirate.manual-rewards/1";
  programId: string;
  mode: "simulated" | "live-testnet";
  chainId: 6343;
  token: string;
  decimals: number;
  operatorWallet: string;
  payoutWallet: string;
  ticketWallet: string;
  veryAppId: string;
  rpcUrl: string;
  resultSourceHash: string;
  /** One explicitly declared mock drawing; all other offers retain real provider evidence. */
  rehearsal?: RewardRehearsal;
  /**
   * Retired rehearsals, oldest first, each with its original terms. A rollover
   * appends the current rehearsal here and names a new one; nothing else changes.
   */
  rehearsalHistory?: RewardRehearsal[];
}
export interface RewardRehearsal {
  schema: "pirate.reward-rehearsal/1";
  offerId: string;
  prizeUsdcAtomic: string;
}
export interface RewardRehearsalTerms extends RewardRehearsal {
  drawingId: string;
  purchaseHash: string;
  ticketIds: string[];
}
export interface RewardPrincipal {
  accountId: string;
  wallet: string;
}
export type ClaimOutcome =
  | "accepted"
  | "verification_missing"
  | "verification_stale"
  | "subject_conflict";
export type PaymentState =
  | "prepared"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "review_required"
  | "cancelled";
export interface RewardCredit {
  credit_id: string;
  offer_id: string;
  account_id: string;
  chain_id: 6343;
  token_address: string;
  token_decimals: number;
  amount_atomic: string;
  paid_atomic: string;
  claim: {
    status: "unclaimed" | "accepted" | "subject_conflict";
    payout_status: "awaiting_payment" | "sending" | "confirmed";
  };
  payment_id: string | null;
}
export interface RewardCreditList {
  object: "reward_credit_list";
  items: RewardCredit[];
  next_cursor: string | null;
}
export interface RewardAvailableOffers {
  practiceOnly: true;
  offers: {
    offerId: string;
    postId: string | null;
    drawingId: string;
    opensAt: number;
    cutoffAt: number;
    ticketCount: number;
  }[];
}
export interface RewardWalletView {
  schema: "pirate.learner-wallet/1";
  address: string;
  chainId: 6343;
  token: string;
  decimals: number;
  balanceAtomic: string | null;
  operator: boolean;
  practiceOnly: boolean;
  drawings: {
    offerId: string;
    drawingId: string;
    cutoffAt: number;
    state: RewardOffer["state"];
    qualified: boolean | null;
  }[];
}
export interface RewardPayment {
  paymentId: string;
  accountId: string;
  sender: string;
  recipient: string;
  chainId: 6343;
  token: string;
  decimals: number;
  amountAtomic: string;
  creditIds: string[];
  state: PaymentState;
  transactionHash: string | null;
  preparedAt: number;
  guardNonce: string;
  everDispatched: boolean;
  latestAttemptId: string | null;
  attempts: RewardPaymentAttempt[];
}
export interface RewardPaymentAttempt {
  attemptId: string;
  action: "pay" | "cancel";
  outcome: "opening" | "approved" | "cancelled" | "error" | "unknown";
  transactionHash: string | null;
  createdAt: number;
}
export interface RewardGuardEvidence {
  chainId: 6343;
  account: string;
  nonce: string;
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  logIndex: number;
  implementation: string;
  transfers: ConfirmedTransfer[];
}
/** An exact canonical transfer; a transaction hash alone is never a payment. */
export interface ConfirmedTransfer {
  chainId: number;
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  logIndex: number;
  sender: string;
  recipient: string;
  token: string;
  amountAtomic: string;
}
export interface RewardOfferInput {
  offerId: string;
  drawingId: string;
  songKey: string;
  cutoffAt: number;
  purchaseHash: string;
  ticketIds: string[];
  opensAt: number;
  /**
   * Hashes of the result sources this offer accepts, fixed at attachment
   * before its window opens. Absent only on offers attached before source
   * succession, which accept the profile's original source alone.
   */
  resultSources?: string[];
}
export interface QualificationEntry {
  accountId: string;
  wallet: string;
  evidenceHash: string;
  completedAt: number;
}
export interface RewardOffer extends RewardOfferInput {
  evidenceMode: RewardsProfile["mode"];
  state: "open" | "closed" | "settled" | "no_prize";
  entries: QualificationEntry[] | null;
  winningsUsdcAtomic: string | null;
  payoutAtomic: string | null;
  remainderAtomic: string | null;
}
export interface VerificationIntent {
  intent_id: string;
  state: "opening" | "pending" | "verified" | "subject_conflict" | "expired";
  expires_at: number;
  launch_url: string | null;
}
/** Provider ports must validate original chain/proof evidence before returning these values. */
export interface RewardSources {
  readonly mode: RewardsProfile["mode"];
  /**
   * Live result sources, in append order, and the one the community currently
   * publishes to. A new offer must pin a subset that includes the current one.
   * Absent for sources that read no public results.
   */
  readonly resultSources?: { accepted: readonly string[]; current: string };
  purchase(
    offer: RewardOfferInput,
    profile: RewardsProfile,
  ): Promise<{ receiptHash: string; mode: RewardsProfile["mode"] }>;
  qualifiers(offer: RewardOfferInput): Promise<QualificationEntry[]>;
  winnings(
    offer: RewardOfferInput,
    profile: RewardsProfile,
    claimHash?: string,
  ): Promise<{
    usdcAtomic: string;
    receiptHash: string;
    transactionHash?: string;
    blockHash?: string;
    blockNumber?: string;
    mode: RewardsProfile["mode"];
  }>;
}
export interface RewardChain {
  /** Null means the payment guard remains unused, not that an old request cannot execute. */
  guard(
    profile: RewardsProfile,
    nonce: string,
    minimumBlock: string,
  ): Promise<RewardGuardEvidence | null>;
  balance(profile: RewardsProfile, owner: string): Promise<string>;
  position(profile: RewardsProfile): Promise<string>;
  confirmedPosition(profile: RewardsProfile): Promise<string>;
  transfer(
    profile: RewardsProfile,
    hash: string,
    expected: { sender: string; recipient: string; amountAtomic: string },
  ): Promise<ConfirmedTransfer | null>;
  /** Confirmed incoming transfers only, never a client assertion about a reserve balance. */
  incoming(
    profile: RewardsProfile,
    hash: string,
    logIndex: number,
  ): Promise<ConfirmedTransfer>;
  outgoing(
    profile: RewardsProfile,
    fromBlock: string,
    toBlock: string,
  ): Promise<ConfirmedTransfer[]>;
}
export interface RewardVerificationProvider {
  open(
    appId: string,
    scope: string,
    challenge: string,
    key: Uint8Array,
    expiresAt: number,
  ): Promise<{ id: string; launchUrl: string }>;
  /** Must perform hosted cryptographic verification and all pinned scope/challenge checks. */
  subject(
    id: string,
    key: Uint8Array,
    scope: string,
    challenge: string,
    expiresAt: number,
  ): Promise<string | null>;
}
