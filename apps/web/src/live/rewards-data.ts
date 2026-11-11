import { get, post } from "./api.ts";
import type { RewardCloseReadinessV1 } from "../wallet/contracts.ts";
import type {
  WalletSendAdapterV1,
  WalletSendIntentV1,
  WalletSendQuoteV1,
} from "../wallet/contracts.ts";
import {
  validateSendIntent,
  validateSendQuote,
} from "../wallet/quoted-send.ts";
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
  liabilities: {
    total: string;
    unclaimed: string;
    held: string;
    accepted: string;
  };
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
  rehearsal?:
    | import("../../../../packages/rewards/contracts.ts").RewardRehearsalTerms
    | null;
  songs: { songKey: string; title: string }[];
  unmatched: import("../../../../packages/rewards/contracts.ts").ConfirmedTransfer[];
  observedBalanceAtomic: string | null;
  closeReadiness?: RewardCloseReadinessV1;
}
import {
  assertRewardCreditOwner,
  rewardAccountId,
  RewardScopeError,
  assertRewardReadCurrent,
  type RewardReadLifetime,
} from "../wallet/private-reward-scope.ts";

export function rewardsData(csrf: string) {
  return {
    async wallet(lifetime?: RewardReadLifetime) {
      assertRewardReadCurrent(lifetime);
      const value = await get<RewardWalletView>("/api/rewards/wallet", {
        headers: { "x-csrf-token": csrf },
        signal: lifetime?.signal,
      });
      assertRewardReadCurrent(lifetime);
      return value;
    },
    async credits(expectedAccountId?: string, lifetime?: RewardReadLifetime) {
      const accountId = rewardAccountId(expectedAccountId);
      const items: RewardCredit[] = [],
        seen = new Set<string>(),
        ids = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        assertRewardReadCurrent(lifetime);
        const value = await get<RewardCreditList & { accountId?: unknown }>(
          `/api/rewards/credits?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          {
            signal: lifetime?.signal,
            headers: {
              "x-csrf-token": csrf,
              "x-pirate-reward-owner": accountId,
            },
          },
        );
        assertRewardReadCurrent(lifetime);
        if (
          !value ||
          typeof value !== "object" ||
          value.object !== "reward_credit_list" ||
          rewardAccountId(value.accountId) !== accountId ||
          !Array.isArray(value.items)
        )
          throw new RewardScopeError();
        assertRewardCreditOwner(value.items, accountId);
        for (const item of value.items) {
          if (ids.has(item.credit_id))
            throw Error(
              "The reward list changed while loading. Refresh to check again.",
            );
          ids.add(item.credit_id);
          items.push(item);
        }
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
    operator: () =>
      get<RewardOperatorView>("/api/operator/rewards", { timeoutMs: 15000 }),
    operation: <T>(path: string, body: unknown) =>
      post<T>(`/api/operator/rewards${path}`, body, csrf),
  };
}
export type RewardsData = ReturnType<typeof rewardsData>;

/** Mount only after lane 7's authenticated guarded-send capability is available. */
export function walletSendData(csrf: string): WalletSendAdapterV1 {
  const path = (id: string) => `/api/rewards/sends/${encodeURIComponent(id)}`;
  const write = <T>(route: string, body: unknown, key: string) =>
    post<T>(route, body, csrf, { "idempotency-key": key });
  return {
    schema: "pirate.wallet-send-adapter/1",
    async current(view) {
      const next = await get<WalletSendIntentV1 | null>(
        "/api/rewards/sends/current",
      );
      return next ? validateSendIntent(view, next) : null;
    },
    async quote(view, request) {
      return validateSendQuote(
        view,
        await post<WalletSendQuoteV1>(
          "/api/rewards/send-quotes",
          request,
          csrf,
        ),
      );
    },
    prepare: (quote) =>
      write<WalletSendIntentV1>(
        "/api/rewards/sends",
        { quoteId: quote.quoteId },
        quote.quoteId,
      ),
    begin: (id, attemptId, action = "pay") =>
      write<WalletSendIntentV1>(
        `${path(id)}/dispatch`,
        { action, attemptId },
        attemptId,
      ),
    outcome: (id, attemptId, result) =>
      write<WalletSendIntentV1>(
        `${path(id)}/outcome`,
        { attemptId, ...result },
        attemptId,
      ),
    reconcile: (id) =>
      post<WalletSendIntentV1>(`${path(id)}/reconcile`, {}, csrf),
    cancel: (id) => write<WalletSendIntentV1>(`${path(id)}/cancel`, {}, id),
  };
}
