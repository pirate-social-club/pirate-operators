// Queued for the coordinator; this lane must not execute tests or other gates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { walletPortfolioView } from "../src/wallet/wallet-portfolio-view.ts";
import {
  winningViews,
  claimStep,
} from "../src/wallet/established/winnings-model.ts";
import { buildWalletHubView } from "../src/wallet/established/wallet-hub-view-model.ts";
import { buildWalletReceiveSheetView } from "../src/wallet/established/wallet-receive-sheet-view-model.ts";
import {
  mossSponsoredSendDependencies,
  sendRecord,
} from "../src/wallet/moss-sponsored-send.ts";
import { rewardWalletIdentity } from "../src/wallet/hosted-send.ts";
import type {
  RewardCredit,
  RewardWalletView,
} from "../../../packages/rewards/contracts.ts";
import type { RewardMoss } from "../src/live/reward-wallet.ts";
import type { WalletSendAdapterV1 } from "../src/wallet/contracts.ts";
import {
  sourceIntent,
  sourceQuote,
  sourceWalletView,
  sourceSender,
  sourceToken,
  sourceSendFixture,
  sourceRecipient,
} from "./reward-wallet-owner-flow-doubles.ts";

const closedCredit: RewardCredit = {
  credit_id: "credit_closed_001",
  offer_id: "offer_closed_001",
  account_id: "11111111-1111-4111-8111-111111111111",
  chain_id: 6343,
  token_address: sourceToken,
  token_decimals: 18,
  amount_atomic: "30000000000000000",
  paid_atomic: "30000000000000000",
  payment_id: "payment_closed_001",
  claim: { status: "accepted", payout_status: "confirmed" },
};
test("coordinator's fully paid 0.03 credit is earned, pending zero and never claimable again", () => {
  const view = {
    ...sourceWalletView,
    accountId: "11111111-1111-4111-8111-111111111111",
    balanceAtomic: "23204550198600016",
  };
  const port = walletPortfolioView(view, [closedCredit]);
  assert.equal(port.summary.earned, "30000000000000000");
  assert.equal(port.summary.pending, "0");
  assert.equal(port.summary.claimable, "0");
  assert.equal(port.balance, "$0.023204550198600016");
  assert.equal(winningViews([closedCredit])[0].status, "Sent to your wallet");
  assert.equal(winningViews([closedCredit])[0].canClaim, false);
  assert.equal(port.sections.length, 1);
  assert.equal(port.sections[0].chainId, "megaeth");
  // Classified operator outgoing cost is not a learner gas charge or a balance adjustment.
  assert.equal(view.balanceAtomic, "23204550198600016");
});
test("unavailable balance stays unknown; exact sub-cent assets and source Receive model keep their own real identity", () => {
  const unavailable = walletPortfolioView(
    { ...sourceWalletView, balanceAtomic: null },
    [],
  );
  assert.equal(unavailable.balance, null);
  assert.equal(unavailable.sections[0].tokens[0].balance, "Unavailable");
  const port = walletPortfolioView(
    { ...sourceWalletView, balanceAtomic: "1" },
    [],
    { address: "0x" + "22".repeat(20), displayName: "Another account" },
  );
  assert.equal(port.wallet.address, sourceSender);
  assert.notEqual(port.wallet.displayName, "Another account");
  assert.equal(port.balance, "$0.000000000000000001");
  const receive = buildWalletReceiveSheetView({
    chainSections: port.sections,
    walletAddress: port.wallet.address,
    open: true,
    onOpenChange() {},
  });
  assert.equal(receive.addressLabel, sourceSender);
  assert.equal(receive.selectedChainId, "megaeth");
  assert.equal(
    buildWalletHubView({
      chainSections: port.sections,
      walletAddress: sourceSender,
      totalBalanceUsd: port.balance,
    }).totalBalanceLabel,
    port.balance,
  );
  assert.equal(claimStep("subject_conflict").kind, "held");
});
test("hosted MOSS is disjoint token-only navigation, with no guarded quote/prepare, fabricated record or standing permission", async () => {
  const requests: unknown[] = [];
  const moss: RewardMoss = {
    initialise: async () => {},
    connect: async () => ({ address: sourceSender, network: "testnet" }),
    open: async () => {},
    callContract: async () => {
      throw Error("unexpected guard call");
    },
    send: async (request) => {
      requests.push(request);
      return { status: "cancelled" };
    },
  };
  const dependencies = mossSponsoredSendDependencies({
    view: () => sourceWalletView,
    loadMoss: async () => moss,
  });
  assert.equal(
    await dependencies.data.read(rewardWalletIdentity(sourceWalletView)),
    null,
  );
  assert.equal(
    (await dependencies.hosted!.open(new AbortController().signal)).outcome,
    "cancelled",
  );
  assert.deepEqual(requests, [{ token: sourceToken }]);
  await assert.rejects(
    dependencies.data.preview("0x" + "22".repeat(20), "max"),
  );
});
test("guarded adapter refuses changed nonce before MOSS; cancellation retains frozen identity and contains no transfer", async () => {
  const intent = sourceIntent(sourceQuote());
  let calls = 0,
    changeNonce = true;
  const adapter: WalletSendAdapterV1 = {
    schema: "pirate.wallet-send-adapter/1",
    current: async () => structuredClone(intent),
    quote: async () => intent.quote,
    prepare: async () => structuredClone(intent),
    begin: async (_id, attemptId, action = "pay") => {
      const next = structuredClone(intent);
      next.payment.state = "awaiting_signature";
      next.payment.latestAttemptId = attemptId;
      next.payment.everDispatched = true;
      if (changeNonce)
        next.payment.guardNonce = (((0x5052n << 176n) | 18n) << 64n).toString();
      next.payment.attempts = [
        {
          attemptId,
          action,
          outcome: "opening",
          transactionHash: null,
          createdAt: 1,
        },
      ];
      return next;
    },
    outcome: async () => structuredClone(intent),
    reconcile: async () => structuredClone(intent),
    cancel: async () => structuredClone(intent),
  };
  const moss: RewardMoss = {
    initialise: async () => {},
    connect: async () => ({ address: sourceSender, network: "testnet" }),
    open: async () => {},
    callContract: async (request) => {
      calls++;
      assert.equal(request.maxGasAllowance, 500000000000n);
      assert.ok(request.data.includes("b70e36f0"));
      assert.ok(!request.data.includes("a9059cbb"));
      return { status: "cancelled" };
    },
  };
  const dependencies = mossSponsoredSendDependencies({
    view: () => sourceWalletView,
    adapter,
    loadMoss: async () => moss,
  });
  const wallet = await dependencies.openWallet(),
    record = sendRecord(sourceWalletView, intent);
  await assert.rejects(
    wallet.approveRecorded(record, "cancel"),
    /prepared Send changed/,
  );
  assert.equal(calls, 0);
  changeNonce = false;
  const approval = await wallet.approveRecorded(record, "cancel");
  assert.equal(approval.intent.payment.guardNonce, intent.payment.guardNonce);
  assert.equal(calls, 1);
  wallet.dispose();
  await assert.rejects(wallet.approveRecorded(record), /wallet_session_closed/);
});
test("an aborted hosted open, changed account or production chain never dispatches", async () => {
  let view: RewardWalletView = sourceWalletView,
    calls = 0;
  const moss: RewardMoss = {
    initialise: async () => {},
    connect: async () => ({ address: sourceSender, network: "testnet" }),
    open: async () => {},
    callContract: async () => {
      calls++;
    },
    send: async () => {
      calls++;
    },
  };
  const dependencies = mossSponsoredSendDependencies({
    view: () => view,
    loadMoss: async () => moss,
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(dependencies.hosted!.open(abort.signal));
  view = { ...sourceWalletView, address: "0x" + "22".repeat(20) };
  await assert.rejects(dependencies.hosted!.open(new AbortController().signal));
  assert.throws(() =>
    mossSponsoredSendDependencies({
      view: () =>
        ({ ...sourceWalletView, chainId: 4326 }) as unknown as RewardWalletView,
    }),
  );
  assert.equal(calls, 0);
});

// The real MOSS adapter canonicalizes the wire recipient before calling the guarded port.
test("source port double retains a canonical original after a checksummed reservation response is lost", async () => {
  const fixture = sourceSendFixture({ reserveFails: true });
  const recipient = sourceRecipient.toUpperCase().replace("0X", "0x");
  const quote = await fixture.dependencies.data.preview(
    recipient,
    "1000000000000000",
  );
  assert.equal(quote.recipient, sourceRecipient);
  await assert.rejects(
    fixture.dependencies.data.reserve(
      fixture.identity,
      recipient,
      quote.amountAtomic,
      "same-command",
      quote,
    ),
    /response_lost/,
  );
  const retained = await fixture.dependencies.data.read(fixture.identity);
  assert.equal(retained?.recipient_address, sourceRecipient);
  assert.equal(retained?.amount_atomic, "1000000000000000");
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.approve, 0);
  assert.equal(fixture.calls.submit, 0);
});
