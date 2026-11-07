import { get, post } from "./api.ts";
import type {
  RewardCredit,
  RewardCreditList,
  RewardWalletView,
  ClaimOutcome,
  VerificationIntent,
  RewardOffer,
  RewardPayment,
} from "../../../../packages/rewards/contracts.ts";

export interface RewardOperatorView {
  offers: RewardOffer[];
  payments: RewardPayment[];
  ready: {
    account_id: string;
    wallet: string;
    credit_id: string;
    amount_atomic: string;
  }[];
  inventory: {
    received_atomic: string;
    reserved_atomic: string;
    paid_atomic: string;
    cost_atomic: string;
  };
  payoutWallet: string;
  practiceOnly: boolean;
  funding: {
    funding_id: string;
    kind: string;
    amount_atomic: string;
    transaction_hash: string;
    log_index: number;
  }[];
  decimals: number;
  token: string;
  chainId: 6343;
  simulatedWinnings: boolean;
  participants: {
    account_id: string;
    wallet: string;
    approved_at: number | null;
  }[];
  songs: { songKey: string; title: string }[];
  unmatched: import("../../../../packages/rewards/contracts.ts").ConfirmedTransfer[];
  observedBalanceAtomic: string | null;
}
export function rewardsData(csrf: string) {
  return {
    wallet: () => get<RewardWalletView>("/api/rewards/wallet"),
    async credits() {
      const items: RewardCredit[] = [],
        seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const value: RewardCreditList = await get<RewardCreditList>(
          `/api/rewards/credits?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        items.push(...value.items);
        cursor = value.next_cursor;
        if (cursor === null) return items;
        if (seen.has(cursor))
          throw Error("The reward list could not be loaded completely.");
        seen.add(cursor);
      }
      throw Error("The reward list could not be loaded completely.");
    },
    claim: (id: string) =>
      post<{ outcome: ClaimOutcome; credit: RewardCredit }>(
        `/api/rewards/credits/${encodeURIComponent(id)}/claim`,
        {},
        csrf,
      ),
    intent: () =>
      post<VerificationIntent>(
        "/api/rewards/claim-verification-intents",
        {},
        csrf,
      ),
    poll: (id: string) =>
      post<VerificationIntent>(
        `/api/rewards/verification-intents/${encodeURIComponent(id)}/complete`,
        {},
        csrf,
      ),
    operator: () => get<RewardOperatorView>("/api/operator/rewards"),
    operation: <T>(path: string, body: unknown) =>
      post<T>(`/api/operator/rewards${path}`, body, csrf),
  };
}
export type RewardsData = ReturnType<typeof rewardsData>;
