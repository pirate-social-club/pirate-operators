// Integration tests for docs/operator-payments.md on local anvil: real
// OperatorPayments redemptions, the community on D1, the operator's queue.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { accounts, keys } from "../harness/runtime.ts";
import { openAttempt, type Attempt } from "../harness/karaoke-client.ts";
import {
  purchaseDomain,
  purchaseMessage,
  purchaseTypes,
  segmentUnit,
  unitHash,
  PAYMENT_GRACE_S,
  songEndMs,
  type Purchase,
  type SignedPurchase,
} from "../packages/protocol/payments.ts";
import { community, startChain, stopChain, type Chain } from "./payments-fixture.ts";

let evm: Chain;
before(async () => {
  evm = await startChain();
});
after(async () => {
  await stopChain(evm);
});

type C = Awaited<ReturnType<typeof community>>;
type A = Awaited<ReturnType<C["attempt"]>>;
async function pay(c: C, a: A, segmentId: string, socket: Attempt = a.socket) {
  const signed = await c.purchase(a.session, a.ticket.body.ticketId, segmentId, a.start);
  assert.equal(signed.status, 200, JSON.stringify(signed.value));
  return { signed: signed.value as SignedPurchase, answer: await socket.pay(signed.value) };
}
async function payAll(c: C, a: A, skip: string[] = []) {
  for (const segment of a.manifest.segments) {
    if (skip.includes(segment.segmentId)) continue;
    const opens = a.start.body.startedAt + Math.max(0, Math.ceil((segment.startMs - 15000) / 1000));
    if (opens > c.now()) await c.at(opens);
    const { answer } = await pay(c, a, segment.segmentId);
    assert.equal(answer.type, "paid", JSON.stringify(answer));
  }
}
async function finish(c: C, a: A) {
  // One second before the song ends, so every line has been reached.
  await c.at(a.start.body.startedAt + Math.ceil(songEndMs(a.manifest) / 1000) - 1);
  a.socket.send({ type: "words", words: c.sung(a.manifest) });
  a.socket.send({ type: "finish" });
  await c.at(c.now() + PAYMENT_GRACE_S);
  const result = await c.result(a.ticket.body.ticketId);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return result.value.body;
}
const redeemDirectly = (signed: SignedPurchase, signer = 0) =>
  evm.write(
    evm.paymentsContract,
    "OperatorPayments",
    "redeem",
    [purchaseMessage(signed.purchase), signed.signature],
    signer,
  );

test("admission is paid by one redemption and a repeated publish pays nothing more", async () => {
  const c = await community(evm, "admission");
  try {
    const session = await c.signIn();
    const before = await c.operatorBalance();
    await c.publish(session, "Admission once");
    assert.equal(await c.operatorBalance(), before + 2000n);
    await c.publish(session, "Admission once");
    assert.equal(await c.operatorBalance(), before + 2000n);
  } finally {
    await c.dispose();
  }
});

test("a full performance pays each line once, closes the ticket and assesses every line", async () => {
  const c = await community(evm, "full");
  try {
    const a = await c.attempt();
    const before = await c.operatorBalance();
    await payAll(c, a);
    assert.equal(await c.operatorBalance(), before + 4000n);
    const result = await finish(c, a);
    assert.equal(result.status, "completed");
    assert.equal(result.paidCount, 4);
    assert.deepEqual(result.lines.map((l) => l.status), ["assessed", "assessed", "assessed", "assessed"]);
    assert.ok(result.closedAtBlock > 0);
    assert.equal(
      await evm.read(evm.paymentsContract, "OperatorPayments", "closed", [
        a.ticket.body.community,
        a.ticket.body.ticketId,
        accounts[2].address,
      ]),
      true,
    );
  } finally {
    await c.dispose();
  }
});

test("purchases whose terms disagree with the quote are refused before redemption", async () => {
  const c = await community(evm, "terms");
  try {
    const a = await c.attempt();
    const signed = (await c.purchase(a.session, a.ticket.body.ticketId, "seg-01", a.start)).value as SignedPurchase;
    const before = await c.operatorBalance();
    for (const change of [
      { recipient: accounts[7].address },
      { amount: "2000" },
      { token: evm.token },
    ] as Partial<Purchase>[]) {
      const answer = await a.socket.pay({ ...signed, purchase: { ...signed.purchase, ...change } });
      assert.deepEqual([answer.type, answer.code], ["error", "invalid_purchase"]);
    }
    assert.equal(await c.operatorBalance(), before);
    assert.equal((await a.socket.pay(signed)).type, "paid");
  } finally {
    await c.dispose();
  }
});

test("a purchase for one ticket is refused on another ticket's socket", async () => {
  const c = await community(evm, "sockets");
  try {
    const first = await c.attempt(5);
    const second = await c.attempt(6);
    const signed = (await c.purchase(first.session, first.ticket.body.ticketId, "seg-01", first.start)).value;
    const answer = await second.socket.pay(signed);
    assert.deepEqual([answer.type, answer.code], ["error", "invalid_purchase"]);
  } finally {
    await c.dispose();
  }
});

test("early and passed lines are refused, a repeat returns the same purchase, and one ticket is open per wallet", async () => {
  const c = await community(evm, "window");
  try {
    const a = await c.attempt();
    const ticketId = a.ticket.body.ticketId;
    const early = await c.purchase(a.session, ticketId, "seg-04", a.start);
    assert.deepEqual([early.status, early.value.error], [400, "purchase_window_not_open"]);
    const first = await c.purchase(a.session, ticketId, "seg-01", a.start);
    await c.at(a.start.body.startedAt + 8);
    const repeat = await c.purchase(a.session, ticketId, "seg-01");
    assert.equal(repeat.value.signature, first.value.signature);
    const passed = await c.purchase(a.session, ticketId, "seg-02");
    assert.deepEqual([passed.status, passed.value.error], [400, "purchase_window_closed"]);
    const other = await c.publish(a.session);
    const second = await c.ticket(a.session, other.songHash);
    assert.deepEqual([second.status, second.value.error], [400, "open_ticket_exists"]);
  } finally {
    await c.dispose();
  }
});

test("a disconnect waits for the reconnect window, a reconnect at 20 seconds resumes, and abandonment follows", async () => {
  const c = await community(evm, "disconnect");
  try {
    const a = await c.attempt();
    const ticketId = a.ticket.body.ticketId;
    // Paid lines keep the operator's unpaid-run stop out of this test.
    await payAll(c, a, ["seg-04"]);
    const t0 = c.now();
    a.socket.close();
    await c.at(t0 + 20);
    assert.equal((await c.result(ticketId)).value.error, "result_not_final");
    const again = (await openAttempt(c.runtime.mf, ticketId, accounts[5])) as Attempt;
    assert.equal(again.ready.resumed, true);
    again.close();
    await c.at(t0 + 20 + 30);
    await c.at(c.now() + PAYMENT_GRACE_S);
    const result = await c.result(ticketId);
    assert.equal(result.value.body.status, "abandoned");
  } finally {
    await c.dispose();
  }
});

test("a purchase still being verified at the deadline is refused, and the closed ticket refuses it on chain", async () => {
  const c = await community(evm, "deadline");
  try {
    const a = await c.attempt();
    await payAll(c, a, ["seg-03", "seg-04"]);
    await c.at(a.start.body.startedAt + 3);
    a.socket.send({ type: "finish" });
    const late = (await c.purchase(a.session, a.ticket.body.ticketId, "seg-03")).value as SignedPurchase;
    await c.fault("operator", "fault:clock-after-verify", c.now() + PAYMENT_GRACE_S);
    const answer = await a.socket.pay(late);
    assert.deepEqual([answer.type, answer.code], ["error", "attempt_closed"]);
    await c.at(c.now() + PAYMENT_GRACE_S);
    const result = (await c.result(a.ticket.body.ticketId)).value.body;
    // The late purchase was never redeemed or counted; the line began after the end.
    assert.equal(result.billing.find((b) => b.segmentId === "seg-03")!.redemption, null);
    assert.equal(result.lines.find((l) => l.lineId === "line-03")!.status, "unattempted");
    await assert.rejects(redeemDirectly(late));
  } finally {
    await c.dispose();
  }
});

test("a third-party redemption just before closure is counted after a crash before the result", async () => {
  const c = await community(evm, "third-party");
  try {
    const a = await c.attempt();
    await payAll(c, a, ["seg-03", "seg-04"]);
    const unseen = (await c.purchase(a.session, a.ticket.body.ticketId, "seg-03")).value as SignedPurchase;
    await redeemDirectly(unseen, 7);
    await c.at(a.start.body.startedAt + 8);
    a.socket.send({ type: "words", words: c.sung(a.manifest) });
    a.socket.send({ type: "finish" });
    await c.fault("operator", "fault:crash-before-result", true);
    await c.at(c.now() + PAYMENT_GRACE_S);
    const result = await c.result(a.ticket.body.ticketId);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    const lines = Object.fromEntries(result.value.body.lines.map((l) => [l.lineId, l.status]));
    assert.deepEqual(lines, {
      "line-01": "assessed",
      "line-02": "assessed",
      "line-03": "assessed",
      "line-04": "unattempted",
    });
  } finally {
    await c.dispose();
  }
});

test("a crash before broadcast followed by expiry still resolves the nonce, so the closure executes", async () => {
  const c = await community(evm, "stuck-nonce");
  try {
    const a = await c.attempt();
    assert.equal((await pay(c, a, "seg-01")).answer.type, "paid");
    await c.fault("operator", "fault:crash-before-broadcast", true);
    const crashed = await pay(c, a, "seg-02");
    assert.deepEqual([crashed.answer.type, crashed.answer.code], ["error", "simulated_crash_before_broadcast"]);
    await c.at(a.start.body.startedAt + 8);
    a.socket.send({ type: "finish" });
    await c.at(crashed.signed.purchase.expiresAt + 5);
    assert.equal((await c.result(a.ticket.body.ticketId)).value.error, "result_not_final");
    await c.runtime.mf.getWorker("operator").then((w) => w.fetch("http://operator.localhost/recover", { method: "POST", body: "{}" }));
    const result = (await c.result(a.ticket.body.ticketId)).value.body;
    assert.deepEqual(result.lines.map((l) => l.status), ["silent", "unpaid", "unpaid", "unattempted"]);
    const transactions = (await c.state("operator", "tx:")).map((r) => r.value as { kind: string; mined: { status: string } | null });
    assert.ok(transactions.every((t) => t.mined));
    assert.deepEqual(
      transactions.map((t) => `${t.kind}:${t.mined!.status}`),
      // Admission, line 1, the crashed line 2 resolved by recovery, then the closure.
      ["redeem:success", "redeem:success", "redeem:reverted", "close:success"],
    );
  } finally {
    await c.dispose();
  }
});

test("a third party redeeming a purchase stuck behind a crashed broadcast confirms the line and the nonce still resolves", async () => {
  const c = await community(evm, "stale-nonce");
  try {
    const a = await c.attempt();
    assert.equal((await pay(c, a, "seg-01")).answer.type, "paid");
    await c.fault("operator", "fault:crash-before-broadcast", true);
    const crashed = await pay(c, a, "seg-02");
    assert.equal(crashed.answer.code, "simulated_crash_before_broadcast");
    await redeemDirectly(crashed.signed, 7);
    await c.at(a.start.body.startedAt + 8);
    a.socket.send({ type: "words", words: c.sung(a.manifest) });
    a.socket.send({ type: "finish" });
    await c.at(c.now() + PAYMENT_GRACE_S);
    assert.equal((await c.result(a.ticket.body.ticketId)).value.error, "result_not_final");
    await c.runtime.mf
      .getWorker("operator")
      .then((w) => w.fetch("http://operator.localhost/recover", { method: "POST", body: "{}" }));
    const result = (await c.result(a.ticket.body.ticketId)).value.body;
    assert.deepEqual(result.lines.map((l) => l.status), ["assessed", "assessed", "unpaid", "unattempted"]);
    const transactions = (await c.state("operator", "tx:")).map(
      (r) => r.value as { kind: string; mined: { status: string } | null },
    );
    // The stale redemption reverts but consumes its nonce, so the closure runs.
    assert.deepEqual(
      transactions.map((t) => `${t.kind}:${t.mined?.status}`),
      ["redeem:success", "redeem:success", "redeem:reverted", "close:success"],
    );
  } finally {
    await c.dispose();
  }
});

test("a rival purchase redeemed for the same unit is not counted as the operator's", async () => {
  const c = await community(evm, "rival");
  try {
    const a = await c.attempt();
    const t = a.ticket.body;
    const rival: Purchase = {
      community: t.community,
      unit: unitHash(segmentUnit(t.ticketId, "seg-01", 0)),
      ticketId: t.ticketId,
      quoteId: t.quoteId,
      operator: accounts[2].address,
      recipient: accounts[7].address,
      token: evm.paymentToken,
      amount: "1",
      validAfter: t.issuedAt - 300,
      expiresAt: t.expiresAt,
    };
    const signature = await privateKeyToAccount(keys[1]).signTypedData({
      domain: purchaseDomain(31337, evm.paymentsContract),
      types: purchaseTypes,
      primaryType: "Purchase",
      message: purchaseMessage(rival),
    });
    await redeemDirectly({ purchase: rival, signature }, 7);
    const { answer } = await pay(c, a, "seg-01");
    assert.deepEqual([answer.type, answer.code], ["error", "already_paid"]);
    const result = await finish(c, a);
    assert.equal(result.lines[0].status, "unpaid");
    assert.equal(result.billing[0].redemption, null);
  } finally {
    await c.dispose();
  }
});

test("withheld lines carry no score, the reward score counts them as zero, and unused reservation is released", async () => {
  const c = await community(evm, "withheld");
  try {
    const a = await c.attempt();
    await payAll(c, a, ["seg-02"]);
    const result = await finish(c, a);
    const line2 = result.lines.find((l) => l.lineId === "line-02")!;
    assert.deepEqual([line2.status, line2.scoreBps], ["unpaid", null]);
    // Fixed denominator: the unpaid line counts zero over all four lines. Three
    // paid lines hold too few words for timing calibration, so they score below
    // a calibrated take.
    const assessed = result.lines.filter((l) => l.status === "assessed");
    assert.equal(assessed.length, 3);
    assert.equal(
      result.rewardScoreBps,
      Math.floor(assessed.reduce((sum, l) => sum + l.scoreBps!, 0) / 4),
    );
    const signed = (await c.result(a.ticket.body.ticketId)).value;
    const qualified = await import("../harness/karaoke-client.ts").then(({ post }) =>
      post(c.runtime.mf, "community", "/qualify", { result: signed }, a.session),
    );
    assert.equal(qualified.status, 200, JSON.stringify(qualified.value));
    const wallet = (await c.state("community", `wallet:${accounts[5].address}`))[0].value;
    assert.deepEqual(wallet, { usage: "3000", sequence: 1, open: null });
  } finally {
    await c.dispose();
  }
});

// Regressions from the d635d46 review: interrupted writes, RPC failure before
// nonce allocation, and a superseded socket closing.
const abortWrites = async (c: C, name: string, when: string) => {
  const db = await c.runtime.mf.getD1Database("DB", "community");
  await db
    .prepare(`CREATE TRIGGER ${name} ${when} BEGIN SELECT RAISE(ABORT, 'test_storage_failure'); END`)
    .run();
  return () => db.prepare(`DROP TRIGGER ${name}`).run();
};
type WalletRow = { usage: string; open: { ticketId: string } | null };
const walletOf = async (c: C) =>
  (await c.state("community", `wallet:${accounts[5].address}`))[0].value as WalletRow;

test("an interrupted ticket write is retried into the same ticket without a second reservation", async () => {
  const c = await community(evm, "ticket-write");
  try {
    const session = await c.signIn();
    const song = await c.publish(session);
    const restore = await abortWrites(c, "abort_ticket", "BEFORE INSERT ON records WHEN NEW.key LIKE 'ticket:%'");
    assert.equal((await c.ticket(session, song.songHash)).status, 400);
    await restore();
    const retry = await c.ticket(session, song.songHash);
    assert.equal(retry.status, 200, JSON.stringify(retry.value));
    const wallet = await walletOf(c);
    assert.deepEqual([wallet.usage, wallet.open?.ticketId], ["4000", retry.value.body.ticketId]);
  } finally {
    await c.dispose();
  }
});

test("an interrupted purchase insert consumes no purchase slot", async () => {
  const c = await community(evm, "purchase-write");
  try {
    const a = await c.attempt();
    const restore = await abortWrites(c, "abort_purchase", "BEFORE INSERT ON records WHEN NEW.key LIKE 'purchase:%'");
    assert.equal((await c.purchase(a.session, a.ticket.body.ticketId, "seg-01", a.start)).status, 400);
    await restore();
    await payAll(c, a);
    const rows = await c.state("community", `purchase:${a.ticket.body.ticketId}:`);
    assert.equal(rows.length, 4);
  } finally {
    await c.dispose();
  }
});

test("an interrupted settlement runs again and releases the unused reservation once", async () => {
  const c = await community(evm, "settle-write");
  try {
    const a = await c.attempt();
    await payAll(c, a, ["seg-02"]);
    await finish(c, a);
    const signed = (await c.result(a.ticket.body.ticketId)).value;
    const { post } = await import("../harness/karaoke-client.ts");
    const restore = await abortWrites(c, "abort_settle", "BEFORE UPDATE ON records WHEN NEW.key LIKE 'wallet:%'");
    assert.equal((await post(c.runtime.mf, "community", "/qualify", { result: signed }, a.session)).status, 400);
    assert.deepEqual([(await walletOf(c)).usage], ["4000"]);
    await restore();
    const qualified = await post(c.runtime.mf, "community", "/qualify", { result: signed }, a.session);
    assert.equal(qualified.status, 200, JSON.stringify(qualified.value));
    assert.deepEqual(await walletOf(c), { usage: "3000", sequence: 1, open: null } as WalletRow);
  } finally {
    await c.dispose();
  }
});

test("an RPC failure before nonce allocation leaves an intent that the retry sends once", async () => {
  let failGasPrice = false;
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const value = JSON.parse(text) as { id: number; method: string };
    res.setHeader("Content-Type", "application/json");
    if (failGasPrice && value.method === "eth_gasPrice") {
      failGasPrice = false;
      res.end(JSON.stringify({ jsonrpc: "2.0", id: value.id, error: { code: -32000, message: "test_rpc_failure" } }));
      return;
    }
    const answer = await fetch(evm.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
    res.end(await answer.text());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const port = (proxy.address() as { port: number }).port;
  const c = await community({ ...evm, rpcUrl: `http://127.0.0.1:${port}` }, "rpc-failure");
  try {
    const a = await c.attempt();
    const signed = (await c.purchase(a.session, a.ticket.body.ticketId, "seg-01", a.start)).value as SignedPurchase;
    failGasPrice = true;
    const first = await a.socket.pay(signed);
    assert.deepEqual([first.type, first.code], ["error", "test_rpc_failure"]);
    const retry = await a.socket.pay(signed);
    assert.equal(retry.type, "paid", JSON.stringify(retry));
    const sent = (await c.state("operator", "tx:")).filter(
      (r) => (r.value as { ref: string }).ref === signed.purchase.unit,
    );
    assert.equal(sent.length, 1);
  } finally {
    await c.dispose();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("closing a superseded socket never disconnects its replacement", async () => {
  const c = await community(evm, "generations");
  try {
    const a = await c.attempt();
    const replacement = (await openAttempt(c.runtime.mf, a.ticket.body.ticketId, accounts[5])) as Attempt;
    assert.equal(replacement.ready.resumed, true);
    try {
      a.socket.close();
    } catch {
      // The operator may already have closed the superseded socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const attempt = (await c.state("operator", "attempt:"))[0].value as { connected: boolean; generation: number };
    assert.deepEqual([attempt.connected, attempt.generation], [true, 2]);
    assert.equal((await pay(c, a, "seg-01", replacement)).answer.type, "paid");
    replacement.close();
  } finally {
    await c.dispose();
  }
});
