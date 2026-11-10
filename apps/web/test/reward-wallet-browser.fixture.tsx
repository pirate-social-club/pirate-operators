// Explicit presentation/provider simulation. These facts are not live chain, Very or MOSS evidence.
import { render } from "@solidjs/web";
import { createSignal, createMemo } from "solid-js";
import QRCode from "qrcode";
import { WalletReceivePanel } from "../src/wallet/receive-panel.tsx";
import { LiveRewardOperator } from "../src/live/reward-operator.tsx";
import { LiveRewardWallet } from "../src/live/rewards.tsx";
import { RewardOfferPanel } from "../src/live/reward-offer-panel.tsx";
import { WalletSendPanel } from "../src/wallet/send-panel.tsx";
import { rewardCloseReadiness } from "../src/wallet/close-readiness.ts";
import type {
  RewardsData,
  RewardOperatorView,
} from "../src/live/rewards-data.ts";
import type {
  RewardWalletView,
  RewardCredit,
  VerificationIntent,
} from "../../../packages/rewards/contracts.ts";
import type {
  WalletSendAdapterV1,
  WalletSendIntentV1,
  WalletSendQuoteV1,
} from "../src/wallet/contracts.ts";
import "../src/live/style.css";

const address = `0x${"11".repeat(20)}`,
  token = `0x${"33".repeat(20)}`;
const view: RewardWalletView = {
  schema: "pirate.learner-wallet/1",
  address,
  chainId: 6343,
  token,
  decimals: 18,
  balanceAtomic: "30000000000000000",
  operator: false,
  practiceOnly: true,
  drawings: [],
};
const increment = (key: string) =>
  localStorage.setItem(
    key,
    String(Number(localStorage.getItem(key) ?? "0") + 1),
  );
const credit = (): RewardCredit => ({
  credit_id: "credit_0001",
  offer_id: "offer_0001",
  account_id: "account_0001",
  chain_id: 6343,
  token_address: token,
  token_decimals: 18,
  amount_atomic: "30000000000000000",
  paid_atomic: "0",
  payment_id: null,
  claim: {
    status: localStorage.getItem("fixture_claimed") ? "accepted" : "unclaimed",
    payout_status: "awaiting_payment",
  },
});
const verification = (): VerificationIntent => ({
  intent_id: "intent_0001",
  state: localStorage.getItem("fixture_verified") ? "verified" : "pending",
  expires_at: Date.now() + 300000,
  launch_url: "https://verify.example/fixture",
});
const data: RewardsData = {
  wallet: async () => ({
    ...view,
    address: localStorage.getItem("fixture_account") ?? view.address,
  }),
  credits: async () => [credit()],
  claim: async () => {
    increment("fixture_claims");
    if (localStorage.getItem("fixture_verified"))
      localStorage.setItem("fixture_claimed", "true");
    return {
      outcome: localStorage.getItem("fixture_claimed")
        ? "accepted"
        : "verification_missing",
      credit: credit(),
    };
  },
  intent: async () => {
    increment("fixture_intents");
    return verification();
  },
  poll: async () => {
    if (localStorage.getItem("fixture_poll_failure"))
      throw Error("simulated offline verification");
    return verification();
  },
  operator: async () => {
    throw Error("not used");
  },
  operation: async () => {
    throw Error("not used");
  },
};
function readIntent(): WalletSendIntentV1 | null {
  return JSON.parse(localStorage.getItem("fixture_intent") ?? "null");
}
function save(intent: WalletSendIntentV1) {
  localStorage.setItem("fixture_intent", JSON.stringify(intent));
  return intent;
}
const adapter: WalletSendAdapterV1 = {
  schema: "pirate.wallet-send-adapter/1",
  current: async () => readIntent(),
  quote: async (_view, request) => {
    increment("fixture_quotes");
    localStorage.setItem("fixture_quote_request", JSON.stringify(request));
    return {
      schema: "pirate.wallet-send-quote/1",
      quoteId: "quote_0001",
      chainId: 6343,
      sender: address,
      recipient: request.recipient,
      token,
      decimals: 18,
      amountAtomic:
        request.amountAtomic === "max"
          ? "28000000000000000"
          : request.amountAtomic,
      balanceAtomic: view.balanceAtomic!,
      fee: {
        token,
        decimals: 18,
        symbol: "USDm",
        reserveAtomic: "2000000000000000",
        estimatedAtomic: "1120649801400000",
      },
      expiresAt: Date.now() + 60000,
      maxGasAllowanceWei: "500000000000",
    };
  },
  prepare: async (quote: WalletSendQuoteV1) => {
    increment("fixture_prepares");
    if (
      readIntent() &&
      !["confirmed", "cancelled"].includes(readIntent()!.payment.state)
    )
      throw Error("send already active");
    const next = save({
      schema: "pirate.wallet-send-intent/1",
      quote,
      payment: {
        paymentId: "send_0001",
        accountId: "account_0001",
        sender: address,
        recipient: quote.recipient,
        token,
        decimals: 18,
        chainId: 6343,
        amountAtomic: quote.amountAtomic,
        creditIds: [],
        state: "prepared",
        transactionHash: null,
        preparedAt: Date.now(),
        guardNonce: (((0x5052n << 176n) | 17n) << 64n).toString(),
        everDispatched: false,
        latestAttemptId: null,
        attempts: [],
      },
    });
    if (localStorage.getItem("fixture_prepare_failure"))
      throw Error("simulated lost prepare response");
    return next;
  },
  begin: async (_id, attemptId, action = "pay") => {
    increment("fixture_begins");
    const next = readIntent()!;
    next.payment.state = "awaiting_signature";
    next.payment.everDispatched = true;
    next.payment.latestAttemptId = attemptId;
    next.payment.attempts.push({
      attemptId,
      action,
      outcome: "opening",
      transactionHash: null,
      createdAt: Date.now(),
    });
    return save(next);
  },
  outcome: async (_id, _attempt, result) => {
    const next = readIntent()!;
    next.payment.state = "submitted";
    next.payment.transactionHash = result.hash ?? null;
    return save(next);
  },
  reconcile: async () => {
    const next = readIntent()!;
    next.payment.state = "confirmed";
    return save(next);
  },
  cancel: async () => {
    const next = readIntent()!;
    if (next.payment.everDispatched)
      throw Error("cannot release dispatched send");
    next.payment.state = "cancelled";
    return save(next);
  },
};
function OperatorFixture(props: { stalled?: boolean }) {
  const cutoffAt = 1000000;
  const offer = {
    offerId: "offer_0001",
    drawingId: "1",
    songKey: token,
    cutoffAt,
    opensAt: 1,
    purchaseHash: token,
    ticketIds: ["1"],
    evidenceMode: "live-testnet" as const,
    state: "open" as const,
    entries: null,
    winningsUsdcAtomic: null,
    payoutAtomic: null,
    remainderAtomic: null,
  };
  const [confirmed, setConfirmed] = createSignal(!!props.stalled);
  window.addEventListener("fixture-confirm", () => setConfirmed(true));
  const current = createMemo(
    () =>
      ({
        offers: [offer],
        songs: [],
        payments: [],
        ready: [],
        funding: [],
        unmatched: [],
        inventory: {
          received_atomic: "0",
          reserved_atomic: "0",
          paid_atomic: "0",
          cost_atomic: "0",
        },
        liabilities: { total: "0", unclaimed: "0", held: "0", accepted: "0" },
        payoutWallet: address,
        observedBalanceAtomic: "0",
        decimals: 18,
        token,
        chainId: 6343,
        simulatedWinnings: false,
        practiceOnly: true,
        closeReadiness: rewardCloseReadiness(
          [offer],
          Date.now(),
          confirmed() ? cutoffAt : cutoffAt - 1,
        ),
      }) as unknown as RewardOperatorView,
  );
  let reads = 0;
  if (props.stalled)
    return (
      <LiveRewardOperator
        csrf="fixture"
        onExit={() => {}}
        data={{
          ...data,
          operator: async () => {
            increment("fixture_operator_reads");
            if (reads++ === 0) return current();
            return new Promise<RewardOperatorView>(() => {});
          },
        }}
      />
    );
  return (
    <RewardOfferPanel
      view={current()}
      data={data}
      busy={false}
      run={async () => {
        increment("fixture_closes");
      }}
    />
  );
}
function ReceiveSwitchFixture() {
  const [wallet, setWallet] = createSignal(view);
  const next = { ...view, address: "0x" + "22".repeat(20) };
  const original = QRCode.toDataURL;
  void original(next.address, { width: 256, margin: 2 }).then((image) =>
    localStorage.setItem("fixture_qr_b", image),
  );
  QRCode.toDataURL = (async (
    text: string,
    options?: { width?: number; margin?: number },
  ) => {
    const image = await original(text, options);
    if (text === view.address)
      await new Promise<void>((resolve) =>
        Object.assign(window, { releaseReceiveA: resolve }),
      );
    return image;
  }) as typeof QRCode.toDataURL;
  return (
    <>
      <WalletReceivePanel view={wallet()} onClose={() => {}} />
      <button onClick={() => setWallet(next)}>Switch fixture account</button>
    </>
  );
}
const mode = new URL(location.href).searchParams.get("fixture");
render(
  () =>
    mode === "receive-switch" ? (
      <ReceiveSwitchFixture />
    ) : mode === "operator-stall" ? (
      <OperatorFixture stalled />
    ) : mode === "operator" ? (
      <OperatorFixture />
    ) : mode === "quoted" ? (
      <WalletSendPanel view={view} adapter={adapter} onClose={() => {}} />
    ) : (
      <LiveRewardWallet csrf="fixture-only" onExit={() => {}} data={data} />
    ),
  document.getElementById("app")!,
);
