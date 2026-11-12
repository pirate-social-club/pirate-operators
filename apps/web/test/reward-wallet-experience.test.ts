import { test } from "node:test";
import assert from "node:assert/strict";
import { rewardSummary, drawingStatus } from "../src/wallet/reward-status.ts";
import { closeAvailability } from "../src/wallet/close-readiness.ts";
import {
  rewardWalletIdentity,
  sendHostedReward,
  type SendLock,
} from "../src/wallet/hosted-send.ts";
import {
  validateSendQuote,
  validateSendIntent,
  sameSendIntent,
} from "../src/wallet/quoted-send.ts";
import type {
  RewardCredit,
  RewardWalletView,
} from "../../../packages/rewards/contracts.ts";
import type { RewardMoss } from "../src/live/reward-wallet.ts";
import type {
  WalletSendQuoteV1,
  WalletSendIntentV1,
  RewardCloseReadinessV1,
} from "../src/wallet/contracts.ts";

const sender = `0x${"11".repeat(20)}`,
  recipient = `0x${"22".repeat(20)}`,
  token = `0x${"33".repeat(20)}`;
const view: RewardWalletView & { accountId: string } = {
  accountId: "11111111-1111-4111-8111-111111111111",
  schema: "pirate.learner-wallet/1",
  address: sender,
  token,
  decimals: 6,
  chainId: 6343,
  balanceAtomic: "30000",
  practiceOnly: true,
  operator: false,
  drawings: [],
};
const credit = (
  id: string,
  status: RewardCredit["claim"]["status"],
  amount = "10000",
  paid = "0",
): RewardCredit => ({
  credit_id: id,
  offer_id: "offer_0001",
  account_id: "11111111-1111-4111-8111-111111111111",
  chain_id: 6343,
  token_address: token,
  token_decimals: 6,
  amount_atomic: amount,
  paid_atomic: paid,
  payment_id: null,
  claim: {
    status,
    payout_status: paid === amount ? "confirmed" : "awaiting_payment",
  },
});
test("wallet separates recorded earnings, pending/needed and available balance, including partial and sub-cent credits", () => {
  const summary = rewardSummary(view, [
    credit("paid", "accepted", "30000", "30000"),
    credit("claim", "unclaimed", "1"),
    credit("held", "subject_conflict", "2"),
    credit("partial", "accepted", "10", "4"),
  ]);
  assert.deepEqual(summary, {
    earned: "30013",
    pending: "9",
    claimable: "1",
    held: "2",
    awaiting: "6",
  });
  assert.equal(view.balanceAtomic, "30000");
  assert.equal(rewardSummary(view, []).pending, "0");
  assert.throws(() =>
    rewardSummary(view, [
      credit("same", "unclaimed"),
      credit("same", "unclaimed"),
    ]),
  );
  assert.throws(() =>
    rewardSummary(view, [{ ...credit("bad", "accepted"), token_decimals: 18 }]),
  );
  assert.throws(() =>
    rewardSummary(view, [credit("bad", "accepted", "1", "2")]),
  );
  assert.equal(
    rewardSummary(view, [credit("large", "accepted", "9007199254740993")])
      .pending,
    "9007199254740993",
  );
});
test("pending or unknown eligibility never reads as guaranteed winnings", () => {
  const drawing = {
    offerId: "offer_001",
    drawingId: "1",
    cutoffAt: 1,
    qualified: null,
    state: "closed",
  } as const;
  assert.match(drawingStatus(drawing), /still being checked/);
  assert.match(
    drawingStatus({ ...drawing, qualified: true }),
    /not guaranteed/,
  );
  assert.equal(
    drawingStatus({ ...drawing, qualified: false }),
    "You did not qualify for this drawing.",
  );
  assert.equal(
    drawingStatus({ ...drawing, state: "no_prize" }),
    "This drawing had no prize.",
  );
});
test("Close entries waits for safe head at exact cutoff and refuses missing, stale and mismatched evidence", () => {
  const cutoffAt = 1000000,
    offer = { offerId: "offer_001", cutoffAt, state: "open" };
  const status = (
    state: "ready" | "awaiting_confirmation",
    stamp = cutoffAt,
  ): RewardCloseReadinessV1 => ({
    schema: "pirate.reward-close-readiness/1",
    checkedAt: cutoffAt + 1000,
    offers: { offer_001: { cutoffAt, state, confirmedTimestamp: stamp } },
  });
  assert.equal(
    closeAvailability(offer, undefined, cutoffAt + 1000).ready,
    false,
  );
  assert.equal(
    closeAvailability(
      offer,
      status("awaiting_confirmation", cutoffAt - 1),
      cutoffAt + 1000,
    ).ready,
    false,
  );
  assert.equal(
    closeAvailability(offer, status("ready", cutoffAt - 1), cutoffAt + 1000)
      .ready,
    false,
  );
  assert.equal(
    closeAvailability(offer, status("ready"), cutoffAt + 1000).ready,
    true,
  );
  assert.equal(
    closeAvailability(offer, status("ready"), cutoffAt + 62000).ready,
    false,
  );
  assert.equal(
    closeAvailability(
      { ...offer, cutoffAt: cutoffAt + 1 },
      status("ready"),
      cutoffAt + 1000,
    ).ready,
    false,
  );
  assert.equal(
    closeAvailability(offer, status("ready"), cutoffAt - 31000).ready,
    false,
  );
  assert.equal(
    closeAvailability(
      { ...offer, state: "closed" },
      status("ready"),
      cutoffAt + 1000,
    ).ready,
    false,
  );
});
function locking(): SendLock {
  let busy = false;
  return {
    async exclusive(_key, work) {
      if (busy) throw Error("locked");
      busy = true;
      try {
        return await work();
      } finally {
        busy = false;
      }
    },
  };
}
test("hosted navigation excludes an overlapping opening but never automatically repeats an uncertain response", async () => {
  const lock = locking();
  let calls = 0,
    finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const moss: RewardMoss = {
    initialise: async () => {},
    connect: async () => ({ address: sender, network: "testnet" }),
    open: async () => {},
    callContract: async () => {
      throw Error("no standing permission");
    },
    send: async (request) => {
      calls++;
      assert.equal(request.token, token);
      await gate;
      throw Error("transport lost");
    },
  };
  const pending = sendHostedReward(view, lock, async () => moss);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    sendHostedReward(view, lock, async () => moss),
    /locked/,
  );
  finish();
  assert.equal((await pending).outcome, "unknown");
  assert.equal(calls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(
    (await sendHostedReward(view, lock, async () => moss)).outcome,
    "unknown",
  );
  assert.equal(calls, 2);
});
test("a completed hosted visit allows another explicit visit without claiming canonical payment confirmation", async () => {
  for (const status of ["approved", "cancelled", "error"]) {
    let visits = 0;
    const moss: RewardMoss = {
      initialise: async () => {},
      connect: async () => ({ address: sender, network: "testnet" }),
      open: async () => {},
      callContract: async () => {
        throw Error("no app-prepared transfer");
      },
      send: async () => {
        visits++;
        return { status };
      },
    };
    const lock = locking();
    assert.equal(
      (await sendHostedReward(view, lock, async () => moss)).outcome,
      status === "approved" ? "unknown" : status,
    );
    assert.equal(visits, 1);
    await sendHostedReward(view, lock, async () => moss);
    assert.equal(visits, 2);
  }
});
test("hosted navigation still refuses another account or network and preserves contradictory hashes as uncertainty", async () => {
  let calls = 0;
  const moss: RewardMoss = {
    initialise: async () => {},
    connect: async () => ({ address: sender, network: "mainnet" }),
    open: async () => {},
    callContract: async () => {},
    send: async () => {
      calls++;
      return {
        status: "cancelled",
        receipt: { chainId: 6343, hash: "0x" + "aa".repeat(32) },
      };
    },
  };
  await assert.rejects(
    sendHostedReward(view, locking(), async () => moss),
    /Open the account/,
  );
  moss.connect = async () => ({ address: recipient, network: "testnet" });
  await assert.rejects(
    sendHostedReward(view, locking(), async () => moss),
    /Open the account/,
  );
  assert.equal(calls, 0);
  assert.throws(() =>
    rewardWalletIdentity({
      ...view,
      chainId: 4326,
    } as unknown as RewardWalletView),
  );
  moss.connect = async () => ({ address: sender, network: "testnet" });
  assert.equal(
    (await sendHostedReward(view, locking(), async () => moss)).outcome,
    "unknown",
  );
  assert.equal(calls, 1);
});
test("closing hosted Send during connection prevents a later wallet Send request", async () => {
  const controller = new AbortController();
  let finish!: () => void,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const moss: RewardMoss = {
    initialise: async () => {},
    connect: async () => {
      await gate;
      return { address: sender, network: "testnet" };
    },
    open: async () => {},
    callContract: async () => {},
    send: async () => {
      calls++;
    },
  };
  const pending = sendHostedReward(
    view,
    locking(),
    async () => moss,
    controller.signal,
  );
  controller.abort();
  finish();
  await assert.rejects(pending, /closed before opening/);
  assert.equal(calls, 0);
});

const quote = (): WalletSendQuoteV1 => ({
  schema: "pirate.wallet-send-quote/1",
  quoteId: "quote_001",
  chainId: 6343,
  sender,
  recipient,
  token,
  decimals: 6,
  balanceAtomic: "30000",
  amountAtomic: "28000",
  fee: {
    token,
    decimals: 6,
    symbol: "USDm",
    reserveAtomic: "2000",
    estimatedAtomic: "1121",
  },
  expiresAt: Date.now() + 60000,
  maxGasAllowanceWei: "500000000000",
});
const sendIntent = (): WalletSendIntentV1 => ({
  schema: "pirate.wallet-send-intent/1",
  quote: quote(),
  payment: {
    paymentId: "send_0001",
    accountId: "learner_001",
    sender,
    recipient,
    chainId: 6343,
    token,
    decimals: 6,
    amountAtomic: "28000",
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
test("small-balance quote separates recipient amount from reserve and rejects impossible Max, stale quotes and currency changes", () => {
  assert.equal(validateSendQuote(view, quote()).amountAtomic, "28000");
  for (const changed of [
    { amountAtomic: "30000" },
    { amountAtomic: "0" },
    { amountAtomic: "1e4" },
    { expiresAt: Date.now() },
    { recipient: sender },
    { token: recipient },
    { chainId: 4326 },
    { sender: recipient },
  ])
    assert.throws(() =>
      validateSendQuote(view, { ...quote(), ...changed } as WalletSendQuoteV1),
    );
  assert.throws(() =>
    validateSendQuote(view, {
      ...quote(),
      fee: { ...quote().fee, estimatedAtomic: "2001" },
    }),
  );
});
test("guarded Send recovery retains immutable nonce/recipient/amount/fee; quote expiry does not invent a new payment on reload", () => {
  const current = sendIntent();
  current.quote.expiresAt = Date.now() - 1;
  assert.equal(validateSendIntent(view, current), current);
  const recovered = structuredClone(current);
  recovered.payment.state = "review_required";
  assert.equal(sameSendIntent(view, current, recovered), recovered);
  for (const changed of [
    { guardNonce: "0" },
    { recipient: token },
    { amountAtomic: "28001" },
    { sender: recipient },
    { chainId: 4326 },
  ])
    assert.throws(() =>
      validateSendIntent(view, {
        ...current,
        payment: { ...current.payment, ...changed },
      } as WalletSendIntentV1),
    );
  const replacement = structuredClone(recovered);
  replacement.payment.guardNonce = (
    ((0x5052n << 176n) | 18n) <<
    64n
  ).toString();
  assert.throws(() => sameSendIntent(view, current, replacement));
  replacement.payment.guardNonce = current.payment.guardNonce;
  replacement.quote.fee.reserveAtomic = "1999";
  assert.throws(() => sameSendIntent(view, current, replacement));
});
