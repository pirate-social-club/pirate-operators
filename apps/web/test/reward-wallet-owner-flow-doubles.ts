// Adapted SOURCE transition/story doubles, never provider or body evidence.
// c7cb8783: wallet-sponsored-send-sheet.test.tsx fixture(), and .stories.tsx storyDependencies().
import type {
  WalletSendIntentV1,
  WalletSendQuoteV1,
} from "../src/wallet/contracts.ts";
import type { RewardWalletView } from "../../../packages/rewards/contracts.ts";
import type {
  WalletSponsoredSendDependencies,
  WalletSponsoredSendRecord,
} from "../src/wallet/sponsored-send-ports.ts";
import { sendRecord } from "../src/wallet/moss-sponsored-send.ts";
import { rewardWalletIdentity } from "../src/wallet/hosted-send.ts";

export const sourceSender = "0x1111111111111111111111111111111111111111";
export const sourceRecipient = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
export const sourceToken = "0x3333333333333333333333333333333333333333";
export const sourceWalletView: RewardWalletView = {
  schema: "pirate.learner-wallet/1",
  address: sourceSender,
  token: sourceToken,
  chainId: 6343,
  decimals: 18,
  balanceAtomic: "30000000000000000",
  practiceOnly: true,
  operator: false,
  drawings: [],
};
export function sourceQuote(
  recipient = sourceRecipient,
  amount = "1000000000000000",
): WalletSendQuoteV1 {
  return {
    schema: "pirate.wallet-send-quote/1",
    quoteId: "quote_source_001",
    sender: sourceSender,
    recipient: recipient.toLowerCase(),
    token: sourceToken,
    chainId: 6343,
    decimals: 18,
    amountAtomic: amount,
    balanceAtomic: sourceWalletView.balanceAtomic!,
    expiresAt: Date.now() + 60000,
    maxGasAllowanceWei: "500000000000",
    fee: {
      token: sourceToken,
      symbol: "USDm",
      decimals: 18,
      reserveAtomic: "2000000000000000",
      estimatedAtomic: "1000000000000000",
    },
  };
}
export function sourceIntent(quote = sourceQuote()): WalletSendIntentV1 {
  return {
    schema: "pirate.wallet-send-intent/1",
    quote,
    payment: {
      paymentId: "send_source_001",
      accountId: "account_fixture",
      sender: sourceSender,
      recipient: quote.recipient,
      token: sourceToken,
      decimals: 18,
      chainId: 6343,
      amountAtomic: quote.amountAtomic,
      creditIds: [],
      state: "prepared",
      transactionHash: null,
      preparedAt: 1,
      guardNonce: (((0x5052n << 176n) | 17n) << 64n).toString(),
      everDispatched: false,
      latestAttemptId: null,
      attempts: [],
    },
  };
}

/** Original options preserve unknown acknowledgements, changed records and authorization holds. */
export function sourceSendFixture(
  options: {
    reserveFails?: boolean;
    submitFails?: boolean;
    changed?: boolean;
    wrongChain?: boolean;
    restoreAllowed?: boolean;
    suspendRestore?: boolean;
    existing?: WalletSponsoredSendRecord;
  } = {},
) {
  let current: WalletSponsoredSendRecord | null = options.existing ?? null;
  const calls = {
    read: 0,
    reserve: 0,
    approve: 0,
    submit: 0,
    restore: 0,
    dispose: 0,
    close: 0,
    confirmed: 0,
  };
  let resolveRestore: (() => void) | undefined;
  const restore = new Promise<void>((resolve) => {
    resolveRestore = resolve;
  });
  const wallet: Awaited<
    ReturnType<WalletSponsoredSendDependencies["openWallet"]>
  > = {
    async restoreAuthorization() {
      calls.restore++;
      if (options.suspendRestore) await restore;
      return options.restoreAllowed !== false;
    },
    async approveRecorded(record) {
      calls.approve++;
      return {
        intent: record.intent,
        attemptId: "attempt_source_001",
        result: { outcome: "unknown" },
      };
    },
    dispose() {
      calls.dispose++;
    },
  };
  const data: WalletSponsoredSendDependencies["data"] = {
    network: {
      chainId: 6343,
      token: sourceToken,
      decimals: 18,
      symbol: "test USDm",
      label: "MegaETH testnet",
      feeDescription:
        "MOSS uses the quoted fee reserve. Unused reserve returns to your wallet.",
    },
    async sender() {
      return { address: sourceSender };
    },
    async tokenBalance() {
      return BigInt(sourceWalletView.balanceAtomic!);
    },
    async read() {
      calls.read++;
      return current !== null && options.changed
        ? {
            ...current,
            recipient_address: "0x2222222222222222222222222222222222222222",
          }
        : current;
    },
    async preview(recipient, amount) {
      return sourceQuote(
        recipient,
        amount === "max" ? "28000000000000000" : amount,
      );
    },
    async reserve(_identity, recipient, amount, _idempotencyKey, quote) {
      calls.reserve++;
      current = sendRecord(
        sourceWalletView,
        sourceIntent({
          ...quote,
          recipient: recipient.toLowerCase(),
          amountAtomic: amount,
        }),
      );
      if (options.wrongChain)
        current = {
          ...current,
          chain_id: 6344,
        } as unknown as WalletSponsoredSendRecord;
      if (options.reserveFails) throw Error("response_lost");
      return current;
    },
    async submit() {
      calls.submit++;
      current = { ...current!, status: "submitted" };
      if (options.submitFails) throw Error("response_lost");
      return current;
    },
    async reconcile() {
      return current!;
    },
    async cancel() {
      current = { ...current!, status: "cancelled", authorization: null };
      return current;
    },
  };
  const dependencies: WalletSponsoredSendDependencies = {
    data,
    async openWallet() {
      return wallet;
    },
    async reauthorize() {
      return false;
    },
  };
  return {
    dependencies,
    calls,
    identity: rewardWalletIdentity(sourceWalletView),
    releaseRestore() {
      resolveRestore?.();
    },
    readRecord: () => current,
  };
}

/** The source review story intentionally never reaches reservation, signing or submission. */
export function sourceReviewStoryDependencies(): WalletSponsoredSendDependencies {
  const fixture = sourceSendFixture();
  return {
    ...fixture.dependencies,
    data: {
      ...fixture.dependencies.data,
      reserve: () => new Promise(() => {}),
    },
    async openWallet() {
      return {
        async restoreAuthorization() {
          return true;
        },
        approveRecorded: () => new Promise(() => {}),
        dispose() {},
      };
    },
  };
}
