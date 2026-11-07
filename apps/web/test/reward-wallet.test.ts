import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dollars,
  dollarInput,
  openRewardWallet,
  signRewardPayment,
  type RewardMoss,
} from "../src/live/reward-wallet.ts";
import type {
  RewardPayment,
  RewardWalletView,
} from "../../../packages/rewards/contracts.ts";

const sender = `0x${"11".repeat(20)}`,
  recipient = `0x${"22".repeat(20)}`,
  token = `0x${"33".repeat(20)}`;
test("operator dollar input keeps full precision and rejects ambiguous or rounded amounts", () => {
  assert.equal(dollarInput("1.11", 6), "1110000");
  assert.equal(dollarInput("0.000001", 6), "1");
  for (const value of ["1e3", "1,000.00", "-1", "0.0000001", "01.11", "1."])
    assert.throws(() => dollarInput(value, 6));
});
const payment: RewardPayment = {
  paymentId: "payment_001",
  accountId: "learner_01",
  sender,
  recipient,
  chainId: 6343,
  token,
  decimals: 6,
  amountAtomic: "180000",
  creditIds: ["credit_001"],
  state: "prepared",
  transactionHash: null,
  preparedAt: 1,
};
test("manual payout dispatch is durable before an explicit MOSS call; only the reviewed recipient and amount are encoded", async () => {
  const events: string[] = [];
  let request: Parameters<RewardMoss["callContract"]>[0] | undefined;
  const moss: RewardMoss = {
    initialise: async (config) => {
      assert.equal(config.network, "testnet");
      events.push("initialise");
    },
    connect: async () => ({ address: sender, network: "testnet" }),
    open: async () => {},
    callContract: async (value) => {
      events.push("call");
      request = value;
      return {
        status: "approved",
        receipt: { chainId: 6343, transactionHash: `0x${"aa".repeat(32)}` },
      };
    },
  };
  const hash = await signRewardPayment(
    payment,
    async () => {
      events.push("persist dispatch");
      return { ...payment, state: "awaiting_signature" };
    },
    async () => moss,
  );
  assert.deepEqual(events, ["initialise", "persist dispatch", "call"]);
  assert.equal(hash, `0x${"aa".repeat(32)}`);
  assert.equal(request?.silent, false);
  assert.equal(request?.sponsor, false);
  assert.equal(request?.address, token);
  assert.equal(
    request?.data,
    `0xa9059cbb${recipient.slice(2).padStart(64, "0")}${180000n.toString(16).padStart(64, "0")}`,
  );
});
test("wrong accounts cannot dispatch; Send opens the same testnet wallet without spending permissions", async () => {
  let dispatched = 0,
    opened = 0;
  const moss: RewardMoss = {
    initialise: async () => {},
    connect: async () => ({ address: recipient, network: "testnet" }),
    open: async () => {
      opened++;
    },
    callContract: async () => {
      throw Error("unexpected transfer");
    },
  };
  await assert.rejects(
    signRewardPayment(
      payment,
      async () => {
        dispatched++;
        return { ...payment, state: "awaiting_signature" };
      },
      async () => moss,
    ),
    /Open the account/,
  );
  assert.equal(dispatched, 0);
  const view: RewardWalletView = {
    schema: "pirate.learner-wallet/1",
    address: recipient,
    chainId: 6343,
    token,
    decimals: 6,
    balanceAtomic: "180000",
    operator: false,
    practiceOnly: true,
    drawings: [],
  };
  await openRewardWallet(view, async () => moss);
  assert.equal(opened, 1);
});
test("dollar amounts preserve sub-cent entitlements and never pass atomic values through floating point", () => {
  assert.equal(dollars("180000", 6), "$0.18");
  assert.equal(dollars("1", 6), "$0.000001");
  assert.equal(dollars("9007199254740993", 6), "$9,007,199,254.740993");
  assert.throws(() => dollars("1e6", 6));
});
