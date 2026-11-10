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
  guardNonce: (((0x5052n << 176n) | 17n) << 64n).toString(),
  everDispatched: false,
  latestAttemptId: null,
  attempts: [],
};
function dispatched(): RewardPayment {
  return {
    ...payment,
    state: "awaiting_signature",
    everDispatched: true,
    latestAttemptId: "attempt_001",
    attempts: [
      {
        attemptId: "attempt_001",
        action: "pay",
        outcome: "opening",
        transactionHash: null,
        createdAt: 1,
      },
    ],
  };
}
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
    "pay",
    "attempt_001",
    async () => {
      events.push("persist dispatch");
      return dispatched();
    },
    async () => moss,
  );
  assert.deepEqual(events, ["initialise", "persist dispatch", "call"]);
  assert.deepEqual(hash, { outcome: "approved", hash: `0x${"aa".repeat(32)}` });
  assert.equal(request?.silent, false);
  assert.equal(request?.sponsor, false);
  assert.equal(request?.address, sender);
  assert.equal(request?.data.slice(0, 10), "0xe9ae5c53");
  assert.ok(
    request?.data.includes(
      `b70e36f0${BigInt(payment.guardNonce).toString(16).padStart(64, "0")}`,
    ),
  );
  assert.ok(
    request?.data.includes(
      `a9059cbb${recipient.slice(2).padStart(64, "0")}${180000n.toString(16).padStart(64, "0")}`,
    ),
  );
});
test("wrong accounts cannot dispatch; Send opens the same testnet wallet without spending permissions", async () => {
  let dispatchCount = 0,
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
      "pay",
      "attempt_001",
      async () => {
        dispatchCount++;
        return dispatched();
      },
      async () => moss,
    ),
    /Open the account/,
  );
  assert.equal(dispatchCount, 0);
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

test("wallet outcomes remain distinct and never imply terminal cancellation; cancellation signs only the frozen nonce", async () => {
  for (const status of ["cancelled", "error", "approved", "unknown", "throw"]) {
    const moss: RewardMoss = {
      initialise: async () => {},
      connect: async () => ({ address: sender, network: "testnet" }),
      open: async () => {},
      callContract: async () => {
        if (status === "throw") throw Error("connection lost");
        return { status };
      },
    };
    assert.deepEqual(
      await signRewardPayment(
        payment,
        "pay",
        "attempt_001",
        async () => dispatched(),
        async () => moss,
      ),
      {
        outcome:
          status === "cancelled" || status === "error" ? status : "unknown",
      },
    );
  }
  let calls = 0;
  const moss: RewardMoss = {
    initialise: async () => {},
    connect: async () => ({ address: sender, network: "testnet" }),
    open: async () => {},
    callContract: async (request) => {
      calls++;
      assert.ok(request.data.includes("b70e36f0"));
      assert.ok(!request.data.includes("a9059cbb"));
      assert.equal(request.address, sender);
      return { status: "cancelled" };
    },
  };
  await signRewardPayment(
    payment,
    "cancel",
    "attempt_001",
    async () => ({
      ...dispatched(),
      attempts: [{ ...dispatched().attempts[0], action: "cancel" }],
    }),
    async () => moss,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    signRewardPayment(
      payment,
      "pay",
      "attempt_001",
      async () => ({
        ...dispatched(),
        guardNonce: (BigInt(payment.guardNonce) + 1n).toString(),
      }),
      async () => moss,
    ),
    /prepared payment changed/,
  );
  assert.equal(calls, 1);
});

test("verified testnet MOSS receipts retain hash candidates when chainId is omitted or only an array is returned", async () => {
  const hash = `0x${"ab".repeat(32)}`;
  for (const result of [
    { status: "approved", receipt: { transactionHash: hash } },
    { status: "approved", receipts: [{ hash, chainId: "0x18c7" }] },
  ]) {
    const moss: RewardMoss = {
      initialise: async () => {},
      connect: async () => ({ address: sender, network: "testnet" }),
      open: async () => {},
      callContract: async () => result,
    };
    assert.deepEqual(
      await signRewardPayment(
        payment,
        "pay",
        "attempt_001",
        async () => dispatched(),
        async () => moss,
      ),
      { outcome: "approved", hash },
    );
    assert.equal(payment.state, "prepared");
    assert.equal(payment.transactionHash, null);
  }
});
test("missing receipt chain metadata never bypasses the connected network check", async () => {
  let persisted = 0,
    calls = 0;
  const moss: RewardMoss = {
    initialise: async () => {},
    connect: async () => ({ address: sender, network: "mainnet" }),
    open: async () => {},
    callContract: async () => {
      calls++;
      return { status: "approved", receipt: { hash: `0x${"ab".repeat(32)}` } };
    },
  };
  await assert.rejects(
    signRewardPayment(
      payment,
      "pay",
      "attempt_001",
      async () => {
        persisted++;
        return dispatched();
      },
      async () => moss,
    ),
    /Open the account/,
  );
  assert.equal(persisted, 0);
  assert.equal(calls, 0);
});

test("a provider-quoted native gas cap is forwarded exactly and invalid caps never dispatch", async () => {
  let calls = 0,
    persisted = 0;
  const moss: RewardMoss = {
    initialise: async () => {},
    connect: async () => ({ address: sender, network: "testnet" }),
    open: async () => {},
    callContract: async (request) => {
      calls++;
      assert.equal(request.maxGasAllowance, 500000000000n);
      assert.equal(request.silent, false);
      assert.equal(request.sponsor, false);
      return { status: "cancelled" };
    },
  };
  const before = async () => {
    persisted++;
    return dispatched();
  };
  await signRewardPayment(
    payment,
    "pay",
    "attempt_001",
    before,
    async () => moss,
    { maxGasAllowanceWei: "500000000000" },
  );
  for (const maxGasAllowanceWei of ["0", "-1", "1e6", (2n ** 256n).toString()])
    await assert.rejects(
      signRewardPayment(
        payment,
        "pay",
        "attempt_001",
        before,
        async () => moss,
        { maxGasAllowanceWei },
      ),
      /fee allowance/,
    );
  assert.equal(calls, 1);
  assert.equal(persisted, 1);
});
