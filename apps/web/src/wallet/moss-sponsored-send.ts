import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import {
  connectRewardWallet,
  openRewardWallet,
  signRewardPayment,
  type RewardMoss,
} from "../live/reward-wallet.ts";
import {
  browserSendLock,
  rewardWalletIdentity,
  sendHostedReward,
} from "./hosted-send.ts";
import {
  sameSendIntent,
  sameSendQuote,
  validateSendIntent,
  validateSendQuote,
} from "./quoted-send.ts";
import type { WalletSendAdapterV1, WalletSendIntentV1 } from "./contracts.ts";
import {
  WalletPortInputError,
  WalletPortResponseValidationError,
  type WalletSponsoredSendDependencies,
  type WalletSponsoredSendRecord,
} from "./sponsored-send-ports.ts";

/** The accepted source's persona key is an opaque selection identity here, never centralized persona authority. */
export function sendRecord(
  view: RewardWalletView,
  intent: WalletSendIntentV1,
): WalletSponsoredSendRecord {
  validateSendIntent(view, intent);
  const p = intent.payment;
  const terminal = p.state === "confirmed" || p.state === "cancelled";
  return {
    send_id: p.paymentId,
    persona_id: rewardWalletIdentity(view),
    status:
      p.state === "prepared" || p.state === "awaiting_signature"
        ? "reserved"
        : p.state,
    chain_id: 6343,
    token_address: p.token,
    sender_address: p.sender,
    recipient_address: p.recipient,
    amount_atomic: p.amountAtomic,
    transaction_hash: p.transactionHash,
    verification_required: false,
    authorization: terminal ? null : intent,
    intent,
  };
}
export function mossSponsoredSendDependencies(options: {
  view: () => RewardWalletView;
  adapter?: WalletSendAdapterV1;
  send?: (view: RewardWalletView) => Promise<void>;
  loadMoss?: () => Promise<RewardMoss>;
}): WalletSponsoredSendDependencies {
  const initial = options.view(),
    identity = rewardWalletIdentity(initial),
    adapter = options.adapter;
  const check = () => {
    const next = options.view();
    if (
      rewardWalletIdentity(next) !== identity ||
      next.decimals !== initial.decimals
    )
      throw new WalletPortResponseValidationError(
        "The account or wallet changed. Reopen Send from your wallet.",
      );
    return next;
  };
  const requireAdapter = () => {
    if (!adapter || adapter.schema !== "pirate.wallet-send-adapter/1")
      throw new WalletPortResponseValidationError(
        "Guarded Send is unavailable here.",
      );
    return adapter;
  };
  const load =
    options.loadMoss ??
    (async () => (await import("@megaeth-labs/wallet-sdk")).mega);
  return {
    externalWalletOwnsFocus: true,
    data: {
      network: {
        chainId: 6343,
        token: initial.token,
        decimals: initial.decimals,
        symbol: "test USDm",
        label: "MegaETH testnet",
        feeDescription: adapter
          ? "MOSS uses the quoted fee reserve. Unused reserve returns to your wallet."
          : "Choose a recipient and amount in MOSS. Review the amount they receive and the fee before approval. MOSS can pay gas in USDm when you have no ETH. Max reserves a fee allowance; unused allowance returns to your wallet.",
      },
      async sender(key) {
        const view = check();
        if (key !== identity)
          throw new WalletPortResponseValidationError(
            "Wallet identity changed.",
          );
        return { address: view.address };
      },
      async tokenBalance(token, sender) {
        const view = check();
        if (
          token.toLowerCase() !== view.token.toLowerCase() ||
          sender.toLowerCase() !== view.address.toLowerCase()
        )
          throw new WalletPortResponseValidationError(
            "Wallet currency changed.",
          );
        return view.balanceAtomic === null
          ? undefined
          : BigInt(view.balanceAtomic);
      },
      async read(key) {
        const view = check();
        if (key !== identity)
          throw new WalletPortResponseValidationError(
            "Wallet identity changed.",
          );
        if (!adapter) return null;
        const intent = await adapter.current(view);
        return intent ? sendRecord(view, intent) : null;
      },
      async preview(recipient, amount) {
        const view = check();
        try {
          const quote = validateSendQuote(
            view,
            await requireAdapter().quote(view, {
              recipient: recipient.toLowerCase(),
              amountAtomic: amount,
            }),
          );
          if (
            quote.recipient.toLowerCase() !== recipient.toLowerCase() ||
            (amount !== "max" && quote.amountAtomic !== amount)
          )
            throw new WalletPortResponseValidationError(
              "The quoted recipient or amount changed.",
            );
          return quote;
        } catch (error) {
          if (error instanceof WalletPortResponseValidationError) throw error;
          throw new WalletPortInputError(
            error instanceof Error
              ? error.message
              : "This balance cannot cover the Send and its reserved fee.",
          );
        }
      },
      async reserve(key, recipient, amount, _operationId, quote) {
        const view = check(),
          service = requireAdapter();
        if (
          key !== identity ||
          quote.recipient.toLowerCase() !== recipient.toLowerCase() ||
          quote.amountAtomic !== amount
        )
          throw new WalletPortResponseValidationError(
            "The prepared Send changed.",
          );
        validateSendQuote(view, quote);
        // Preserve server-side intent identity even after a lost prepare response or another tab's request.
        const current = await service.current(view);
        if (
          current &&
          !["confirmed", "cancelled"].includes(current.payment.state)
        )
          return sendRecord(view, current);
        const next = validateSendIntent(view, await service.prepare(quote));
        if (!sameSendQuote(quote, next.quote))
          throw new WalletPortResponseValidationError(
            "The prepared Send changed.",
          );
        return sendRecord(view, next);
      },
      async submit(id, approval) {
        const view = check();
        if (approval.intent.payment.paymentId !== id)
          throw new WalletPortResponseValidationError(
            "The prepared Send changed.",
          );
        const next = sameSendIntent(
          view,
          approval.intent,
          await requireAdapter().outcome(
            id,
            approval.attemptId,
            approval.result,
          ),
        );
        return sendRecord(view, next);
      },
      async reconcile(id) {
        const view = check(),
          service = requireAdapter(),
          before = await service.current(view);
        if (!before || before.payment.paymentId !== id)
          throw new WalletPortResponseValidationError(
            "The recorded send changed. Nothing was signed.",
          );
        return sendRecord(
          check(),
          sameSendIntent(view, before, await service.reconcile(id)),
        );
      },
      async cancel(id) {
        const view = check(),
          service = requireAdapter(),
          before = await service.current(view);
        if (
          !before ||
          before.payment.paymentId !== id ||
          before.payment.everDispatched
        )
          throw new WalletPortResponseValidationError(
            "The recorded send changed. Check its nonce before cancellation.",
          );
        return sendRecord(
          check(),
          sameSendIntent(view, before, await service.cancel(id)),
        );
      },
    },
    async openWallet() {
      let disposed = false;
      return {
        async restoreAuthorization() {
          const view = check();
          await connectRewardWallet(view.address, load);
          return !disposed && rewardWalletIdentity(check()) === identity;
        },
        async approveRecorded(record, action = "pay") {
          if (disposed) throw new Error("wallet_session_closed");
          const view = check(),
            service = requireAdapter(),
            intent = record.intent;
          validateSendIntent(view, intent);
          const attemptId = crypto.randomUUID();
          const result = await signRewardPayment(
            intent.payment,
            action,
            attemptId,
            async () => {
              if (disposed) throw new Error("wallet_session_closed");
              const next = sameSendIntent(
                check(),
                intent,
                await service.begin(record.send_id, attemptId, action),
              );
              if (disposed) throw new Error("wallet_session_closed");
              return next.payment;
            },
            load,
            { maxGasAllowanceWei: intent.quote.maxGasAllowanceWei },
          );
          // This envelope is a receipt candidate, never an exported private key or signing authority.
          return { intent, attemptId, result };
        },
        dispose() {
          disposed = true;
        },
      };
    },
    async reauthorize(signal) {
      if (signal.aborted) return false;
      await connectRewardWallet(check().address, load);
      return !signal.aborted;
    },
    ...(!adapter
      ? {
          hosted: {
            async open(signal: AbortSignal) {
              const view = check();
              if (signal.aborted) throw new Error("wallet_session_closed");
              if (options.send) {
                await options.send(view);
                return { outcome: "unknown" as const };
              }
              return sendHostedReward(view, browserSendLock(), load, signal);
            },
            async history() {
              await openRewardWallet(check(), load);
            },
          },
        }
      : {}),
  };
}
