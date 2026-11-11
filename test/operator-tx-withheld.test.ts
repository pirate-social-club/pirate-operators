import { currentOperatorAuthorityFixture } from "./learning-current-authority-fixture.ts";
import { studyExercisesHash } from "../packages/protocol/learning-results-v3.ts";
import { chain } from "../harness/chain.ts";
import { stopChain } from "./payments-fixture.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { firstSong } from "../services/first-song-profile.ts";
// The operator journal's withheld-row rules against a scripted JSON-RPC
// endpoint, on a chain id that prices the data fee: a row still "none" never
// gives its signed bytes to any RPC before its send, a withheld row is
// settled from receipts and chain state only, an older row counts as never
// sent only when it was never signed, and every waiting state is logged.
// No network: fetch is replaced for the duration of each test.
import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  keccak256,
  serializeTransaction,
  type Hex,
} from "viem";
import { accounts, keys } from "../harness/runtime.ts";
import {
  dispatch,
  enqueue,
  intentOf,
  recheckSuperseded,
  recoverTransactions,
  txRow,
  WITHHELD_SETTLEMENT_DEPTH,
  withheldUnpublished,
  type SendGate,
  type TxRow,
  type TxStore,
} from "../services/operator-tx.ts";
import type { Env } from "../services/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import type { TelegramStudyFacts } from "../packages/study/telegram-publication.ts";
import { legacyResultGate, type ResultStore } from "../services/learning-transactions.ts";
import { recordTelegramStudyDenial } from "../services/study-telegram-publication.ts";
import { warnings } from "./unsent-result-support.ts";

const operator = accounts[2]!.address;
const results = "0x00000000000000000000000000000000000000a3" as const;

function journal(): TxStore {
  let rows = new Map<string, unknown>();
  return {
    get: <T>(key: string) => rows.get(key) as T | undefined,
    set: (key, value) => void rows.set(key, JSON.parse(JSON.stringify(value))),
    delete: (key) => void rows.delete(key),
    entries: (prefix) =>
      [...rows]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, value]) => ({ key, value })),
    transaction: <T>(fn: () => T) => {
      const prior = new Map(rows);
      try {
        return fn();
      } catch (error) {
        rows = prior;
        throw error;
      }
    },
  };
}
/**
 * A scripted node: every request body is kept, sends are recorded and known
 * by hash, and mining is explicit. A sent row can be mined later with
 * `mine`; `advance` moves the head; `lag` makes the next reads of a method
 * answer null, as a lagging replica would.
 */
function node() {
  const real = globalThis.fetch;
  const state = {
    bodies: [] as string[],
    sent: [] as Hex[],
    priced: [] as Hex[],
    latest: 0,
    head: 100,
    known: new Set<Hex>(),
    receipts: new Map<Hex, { status: Hex; blockNumber: Hex; transactionHash: Hex; logs: [] }>(),
    lagging: new Map<string, number>(),
    mineSends: true,
    gasPrice: 10n ** 9n,
    dataFee: 0n,
  };
  const mine = (raw: Hex) => {
    const hash = keccak256(raw);
    state.known.add(hash);
    state.receipts.set(hash, {
      status: "0x1",
      blockNumber: ("0x" + state.head.toString(16)) as Hex,
      transactionHash: hash,
      logs: [],
    });
    state.latest += 1;
    state.head += 1;
  };
  const lagged = (method: string) => {
    const left = state.lagging.get(method) ?? 0;
    if (left > 0) state.lagging.set(method, left - 1);
    return left > 0;
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    state.bodies.push(body);
    const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: any[] };
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        headers: { "content-type": "application/json" },
      });
    switch (method) {
      case "eth_gasPrice":
        return reply("0x" + state.gasPrice.toString(16));
      case "eth_getTransactionCount":
        return reply("0x" + state.latest.toString(16));
      case "eth_estimateGas":
        return reply("0x5208");
      case "eth_blockNumber":
        return reply("0x" + state.head.toString(16));
      case "eth_getTransactionByHash":
        return reply(
          !lagged(method) && state.known.has(params[0]) ? { hash: params[0] } : null,
        );
      case "eth_call": {
        // GasPriceOracle.getL1Fee(bytes): record the bytes and return the current fixture price.
        const data = params[0].data as Hex;
        const [priced] = (await import("viem")).decodeAbiParameters([{ type: "bytes" }], `0x${data.slice(10)}`);
        state.priced.push(priced as Hex);
        return reply(encodeAbiParameters([{ type: "uint256" }], [state.dataFee]));
      }
      case "eth_getTransactionReceipt":
        return reply(lagged(method) ? null : (state.receipts.get(params[0]) ?? null));
      case "eth_sendRawTransaction":
        state.sent.push(params[0]);
        state.known.add(keccak256(params[0]));
        if (state.mineSends) mine(params[0]);
        return reply(keccak256(params[0]));
    }
    throw new Error(`unscripted ${method}`);
  }) as typeof fetch;
  return {
    state,
    mine,
    advance: (blocks = WITHHELD_SETTLEMENT_DEPTH) => void (state.head += blocks),
    lag: (method: string, times = 1) => void state.lagging.set(method, times),
    restore: () => void (globalThis.fetch = real),
  };
}
const env = {
  RPC_URL: "http://node.invalid",
  PAYMENT_CHAIN_ID: "6343",
  PRIVATE_KEY: keys[2],
  RESULTS_V2_CONTRACT: "0x00000000000000000000000000000000000000a2",
  SPONSOR_DATA_FEE_WEI: "1000",
} as unknown as Env;
const limits = { maxFeePerGas: 10n ** 10n, maxTotalFee: 10n ** 18n };
function gate(withdrawn: { value: boolean }, configured = true): SendGate {
  return {
    reason: "authorization_withdrawn",
    recorded: (kind) => kind === "record_result" && withdrawn.value,
    withheld: async (kind) => kind === "record_result" && withdrawn.value,
    limits: () => (configured ? limits : undefined),
  };
}
const unsigned = (row: TxRow) =>
  serializeTransaction({
    type: "legacy",
    chainId: row.chainId,
    nonce: row.nonce,
    to: row.to,
    data: row.data,
    gas: BigInt(row.gas),
    gasPrice: BigInt(row.gasPrice),
    value: 0n,
  });
const carries = (bodies: string[], raw: Hex) =>
  bodies.some((body) => body.includes(raw.slice(2)));
/** A result transaction allocated and signed, then a crash before its send. */
async function allocated(store: TxStore, n: ReturnType<typeof node>) {
  enqueue(store, "record_result", "ticket:1", results, "0x1234", 200_000n);
  store.set("fault:crash-before-broadcast", true);
  await assert.rejects(
    dispatch(env, store, "record_result", "ticket:1", limits, gate({ value: false })),
    /simulated_crash_before_broadcast/,
  );
  const row = txRow(store, intentOf(store, "record_result", "ticket:1")!.nonce!)!;
  assert.equal(row.broadcast, "none");
  assert.ok(row.raw);
  assert.equal(carries(n.state.bodies, row.raw!), false);
  return row;
}
const key = (row: TxRow) => `tx:${String(row.nonce).padStart(10, "0")}`;
test("a row still none is priced unsigned; its signed bytes reach the RPC only in its own send", async () => {
  const n = node();
  try {
    const store = journal();
    const row = await allocated(store, n);
    const sent = await dispatch(env, store, "record_result", "ticket:1", limits, gate({ value: false }));
    assert.deepEqual(n.state.priced, [unsigned(row)]);
    assert.deepEqual(n.state.sent, [row.raw]);
    // Before the send body, no request carried the signed bytes.
    const sendIndex = n.state.bodies.findIndex((b) => b.includes("eth_sendRawTransaction"));
    assert.equal(carries(n.state.bodies.slice(0, sendIndex), row.raw!), false);
    assert.equal(sent?.broadcast, "attempted");
    assert.equal(sent?.mined?.status, "success");
  } finally {
    n.restore();
  }
});

test("a V4-only community prices an unsent result and refuses an excessive data fee", async () => {
  const n = node();
  try {
    const store = journal();
    const v4 = { ...env, RESULTS_V2_CONTRACT: undefined, RESULTS_V4_CONTRACT: results };
    enqueue(store, "record_result", "v4:1", results, "0x1234", 200_000n);
    n.state.dataFee = 1001n;
    const send = () => dispatch(v4, store, "record_result", "v4:1", limits, gate({ value: false }));
    await assert.rejects(send, /data_fee_above_limit/);
    const row = txRow(store, intentOf(store, "record_result", "v4:1")!.nonce!)!;
    assert.equal(row.broadcast, "none");
    assert.deepEqual(n.state.priced, [unsigned(row)]);
    assert.deepEqual(n.state.sent, []);
    assert.equal(carries(n.state.bodies, row.raw!), false);

    n.state.dataFee = 1000n;
    assert.equal((await send())?.mined?.status, "success");
    assert.deepEqual(n.state.priced, [unsigned(row), unsigned(row)]);
    assert.deepEqual(n.state.sent, [row.raw]);
    assert.equal((await send())?.nonce, row.nonce);
    assert.equal(n.state.sent.length, 1);
  } finally {
    n.restore();
  }
});

test("a payment row is priced from its signed bytes, as before", async () => {
  const n = node();
  try {
    const store = journal();
    enqueue(store, "close", "ticket:1", results, "0x1234", 200_000n);
    const sent = (await dispatch(env, store, "close", "ticket:1"))!;
    assert.deepEqual(n.state.priced, [sent.raw]);
    assert.equal(sent.broadcast, undefined);
    assert.equal(sent.mined?.status, "success");
  } finally {
    n.restore();
  }
});

test("a withheld row proven never sent: its signed bytes never reach any RPC; its cancellation is priced unsigned", async () => {
  const n = node();
  try {
    const store = journal();
    const row = await allocated(store, n);
    const first = (await dispatch(env, store, "record_result", "ticket:1", limits, gate({ value: true })))!;
    // Mined, but not yet deep enough to settle.
    assert.equal(first.mined, null);
    n.advance();
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    const settled = txRow(store, row.nonce)!;
    assert.equal(carries(n.state.bodies, row.raw!), false);
    assert.equal(settled.mined?.status, "cancelled");
    assert.equal(n.state.sent.length, 1);
    assert.equal(keccak256(n.state.sent[0]!), settled.cancellation!.hash);
    // Priced: the own transaction unsigned, before the withdrawal read, then
    // the cancellation unsigned.
    assert.equal(n.state.priced.length, 2);
    assert.equal(n.state.priced[0], unsigned(row));
    assert.ok(!n.state.priced.includes(settled.cancellation!.raw!));
    assert.equal(withheldUnpublished(settled), true);
  } finally {
    n.restore();
  }
});

test("a withheld none row whose own transaction is mined after all is recorded as mined, never as private", async () => {
  const n = node();
  try {
    const store = journal();
    const row = await allocated(store, n);
    // The limits refuse the cancellation; the row is withheld and waits.
    n.state.gasPrice = 10n ** 11n;
    const logged = await warnings(() => recoverTransactions(env, store, async () => true, gate({ value: true })));
    assert.ok(txRow(store, row.nonce)!.withheld);
    assert.ok(logged.some((l) => l.includes("operator_cancellation_waiting") && l.includes("gas_price_above_limit")));
    // Its bytes reach the chain by some other path.
    n.mine(row.raw!);
    n.state.gasPrice = 10n ** 9n;
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    assert.equal(txRow(store, row.nonce)!.mined, null, "not yet deep enough");
    n.advance();
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    const settled = txRow(store, row.nonce)!;
    assert.equal(settled.mined?.status, "success");
    assert.equal(settled.cancellation, undefined);
    assert.equal(withheldUnpublished(settled), false);
  } finally {
    n.restore();
  }
});

test("an older row counts as never sent only when it was never signed", async () => {
  const n = node();
  try {
    // Signed under the old journal, no marker: sent or uncertain.
    const signedStore = journal();
    const signed = await allocated(signedStore, n);
    const legacy = { ...signed };
    delete legacy.broadcast;
    signedStore.set(key(legacy), legacy);
    const logged = await warnings(() =>
      recoverTransactions(env, signedStore, async () => true, gate({ value: true })),
    );
    const held = txRow(signedStore, signed.nonce)!;
    assert.ok(held.withheld);
    assert.equal(held.cancellation, undefined);
    assert.equal(held.mined, null);
    assert.equal(carries(n.state.bodies, signed.raw!), false);
    assert.ok(logged.some((l) => l.includes("operator_nonce_withheld")));
    // Allocated under the old journal and never signed: never sent.
    const unsignedStore = journal();
    const bare = { ...(await allocated(unsignedStore, n)) };
    delete bare.broadcast;
    delete bare.raw;
    delete bare.hash;
    unsignedStore.set(key(bare), bare);
    n.state.sent.length = 0;
    await recoverTransactions(env, unsignedStore, async () => true, gate({ value: true }));
    n.advance();
    await recoverTransactions(env, unsignedStore, async () => true, gate({ value: true }));
    const cancelled = txRow(unsignedStore, bare.nonce)!;
    assert.equal(cancelled.mined?.status, "cancelled");
    assert.equal(cancelled.raw, undefined);
    assert.equal(n.state.sent.length, 1);
    assert.equal(keccak256(n.state.sent[0]!), cancelled.cancellation!.hash);
    // Signed only now, while withdrawal is unknown: it is marked none first.
    const lateStore = journal();
    const late = { ...(await allocated(lateStore, n)) };
    delete late.broadcast;
    delete late.raw;
    delete late.hash;
    lateStore.set(key(late), late);
    n.state.bodies.length = 0;
    const sent = (await dispatch(env, lateStore, "record_result", "ticket:1", limits, gate({ value: false })))!;
    assert.equal(sent.broadcast, "attempted");
    assert.deepEqual(n.state.priced.at(-1), unsigned(sent));
  } finally {
    n.restore();
  }
});

test("without sponsor limits a waiting cancellation is logged, and nothing is sent", async () => {
  const n = node();
  try {
    const store = journal();
    await allocated(store, n);
    const logged = await warnings(() =>
      recoverTransactions(env, store, async () => true, gate({ value: true }, false)),
    );
    assert.deepEqual(n.state.sent, []);
    assert.ok(
      logged.some((l) => l.includes("operator_cancellation_waiting") && l.includes("sponsor_limits_unconfigured")),
    );
    assert.equal(txRow(store, intentOf(store, "record_result", "ticket:1")!.nonce!)!.mined, null);
  } finally {
    n.restore();
  }
});

test("a nonce consumed with nothing found is superseded only on reads the depth apart; recovery then continues and a later receipt corrects it", async () => {
  const n = node();
  try {
    const store = journal();
    // A sent row whose fate is unknown, then a payment behind it.
    enqueue(store, "record_result", "ticket:1", results, "0x1234", 200_000n);
    n.state.mineSends = false;
    await dispatch(env, store, "record_result", "ticket:1", limits, gate({ value: false }));
    const row = txRow(store, 0)!;
    assert.equal(row.broadcast, "attempted");
    enqueue(store, "close", "close:1", results, "0x", 50_000n);
    await dispatch(env, store, "close", "close:1");
    const sentBefore = n.state.sent.length;
    const stuck = await warnings(() => recoverTransactions(env, store, async () => true, gate({ value: true })));
    assert.ok(stuck.some((l) => l.includes("operator_nonce_withheld")));
    assert.equal(txRow(store, 1)!.mined, null, "the payment waits behind it");
    assert.equal(n.state.sent.slice(sentBefore).includes(row.raw!), false);
    // Something else consumes nonce 0, and the node no longer knows the row.
    n.state.mineSends = true;
    n.state.latest = 1;
    n.state.known.delete(row.hash!);
    const first = await warnings(() => recoverTransactions(env, store, async () => true, gate({ value: true })));
    assert.ok(first.some((l) => l.includes("operator_nonce_unexplained")));
    assert.equal(txRow(store, 0)!.mined, null, "one read is not enough");
    n.advance(WITHHELD_SETTLEMENT_DEPTH - 1);
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    assert.equal(txRow(store, 0)!.mined, null, "nor reads less than the depth apart");
    n.advance(1);
    const reconciled = await warnings(() => recoverTransactions(env, store, async () => true, gate({ value: true })));
    assert.ok(reconciled.some((l) => l.includes("operator_nonce_superseded")));
    const superseded = txRow(store, 0)!;
    assert.equal(superseded.mined?.status, "superseded");
    assert.equal(superseded.raw, row.raw);
    assert.equal(superseded.hash, row.hash);
    assert.equal(withheldUnpublished(superseded), true);
    assert.equal(txRow(store, 1)!.mined?.status, "success");
    assert.equal(n.state.sent.filter((raw) => raw === row.raw).length, 1, "sent once, before the withdrawal");
    // Its receipt appears after all: the re-check records the truth.
    n.state.receipts.set(row.hash!, { status: "0x1", blockNumber: "0x64", transactionHash: row.hash!, logs: [] });
    await recheckSuperseded(env, store, 0, true);
    assert.equal(txRow(store, 0)!.mined?.status, "success");
    assert.equal(withheldUnpublished(txRow(store, 0)), false);
  } finally {
    n.restore();
  }
});

test("a mined original whose receipt and transaction reads lag once is never settled superseded", async () => {
  const n = node();
  try {
    const store = journal();
    enqueue(store, "record_result", "ticket:1", results, "0x1234", 200_000n);
    n.state.mineSends = false;
    await dispatch(env, store, "record_result", "ticket:1", limits, gate({ value: false }));
    const row = txRow(store, 0)!;
    // The withdrawal is observed while the send's fate is unknown.
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    assert.ok(txRow(store, 0)!.withheld);
    // The original mines; the replica lags once on both reads.
    n.mine(row.raw!);
    n.lag("eth_getTransactionReceipt");
    n.lag("eth_getTransactionByHash");
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    assert.equal(txRow(store, 0)!.mined, null);
    n.advance();
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    const settled = txRow(store, 0)!;
    assert.equal(settled.mined?.status, "success");
    assert.equal(settled.withheld?.unexplainedSince, undefined);
    assert.equal(withheldUnpublished(settled), false);
  } finally {
    n.restore();
  }
});

test("a cancellation receipt that a reorg removes before it is deep never settles the row", async () => {
  const n = node();
  try {
    const store = journal();
    const row = await allocated(store, n);
    await dispatch(env, store, "record_result", "ticket:1", limits, gate({ value: true }));
    const cancellation = txRow(store, row.nonce)!.cancellation!;
    assert.ok(n.state.receipts.has(cancellation.hash!));
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    assert.equal(txRow(store, row.nonce)!.mined, null, "shallow: not settled");
    // A reorg drops it: no receipt, nonce not consumed.
    n.state.receipts.delete(cancellation.hash!);
    n.state.latest -= 1;
    n.advance();
    n.state.sent.length = 0;
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    // Sent again, same bytes, mined again, then settled once deep.
    assert.deepEqual(n.state.sent, [cancellation.raw]);
    assert.equal(txRow(store, row.nonce)!.mined, null);
    n.advance();
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    assert.equal(txRow(store, row.nonce)!.mined?.status, "cancelled");
  } finally {
    n.restore();
  }
});

test("a consumed nonce whose receipt lags but whose transaction the node knows is never inferred superseded", async () => {
  const n = node();
  try {
    const store = journal();
    enqueue(store, "record_result", "ticket:1", results, "0x1234", 200_000n);
    n.state.mineSends = false;
    await dispatch(env, store, "record_result", "ticket:1", limits, gate({ value: false }));
    const row = txRow(store, 0)!;
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    n.mine(row.raw!);
    // Receipts lag on two reads the depth apart; the transaction is known.
    n.lag("eth_getTransactionReceipt", 2);
    const logged = await warnings(async () => {
      await recoverTransactions(env, store, async () => true, gate({ value: true }));
      n.advance();
      await recoverTransactions(env, store, async () => true, gate({ value: true }));
    });
    assert.equal(txRow(store, 0)!.mined, null);
    assert.ok(logged.some((l) => l.includes("operator_nonce_settling")));
    assert.ok(!logged.some((l) => l.includes("operator_nonce_superseded")));
    await recoverTransactions(env, store, async () => true, gate({ value: true }));
    assert.equal(txRow(store, 0)!.mined?.status, "success");
  } finally {
    n.restore();
  }
});

test(
  "persisted Telegram grant denial wins during an awaited resolver after a signed restart",
  { timeout: 120000 },
  async () => {
    const evm = await chain(20367, 6343);
    const realFetch = globalThis.fetch;
    const owned: ReturnType<typeof currentOperatorAuthorityFixture>[] = [];
    let n: ReturnType<typeof node> | undefined;
    try {
      const communityId = `0x${"66".repeat(32)}` as Hex;
      const results = (
        await evm.deploy("LearningResultsV4", [
          accounts[3].address,
          communityId,
          learningV4PublicityPolicy,
          firstSong.origin,
        ])
      ).toLowerCase() as Hex;
      n = node();
      const scriptedFetch = globalThis.fetch;
      // The existing transaction/data-fee node stays scripted. Source inspection
      // goes unchanged to the real local V4 RPC; it is not an admission proof.
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) =>
        (input instanceof Request ? input.url : String(input)) === evm.rpcUrl
          ? realFetch(input, init)
          : scriptedFetch(input, init)) as typeof fetch;
      const authority = currentOperatorAuthorityFixture({
        now: () => 1800000000,
        rpcUrl: evm.rpcUrl,
      });
      owned.push(authority);
      const initial = authority.store;
      const lessonId = "linked_lesson_fixture_1";
      const ref = `study:${lessonId}:1`;
      // This transaction-journal race retains the original captured binding ID.
      // The remote resolver is deliberately stale below. It is not a chain
      // authorization proof; real signed admission is covered by route fixtures.
      const authorizationId = `0x${"33".repeat(32)}` as Hex;
      const facts: TelegramStudyFacts = {
        schema: "pirate.study.telegram-publication-fence/1",
        version: 1,
        grantId: "grant_fixture",
        accountId: "account_fixture",
        authorityVersion: "version_1",
        actor: {
          communityId,
          botId: "50",
          generation: 1,
          userId: "60",
          chatId: "60",
        },
      };
      const telegramFence = { facts, hash: digest(facts) as Hex };
      const target = { version: 4, chainId: 6343, contract: results };
      const learner = accounts[1]!.address.toLowerCase();
      const startedAt = 1_799_999_999_500;
      const offer = {
        lessonId,
        speechChannel: "telegram-linked" as const,
        telegramFence,
        authorizationId,
        learner,
        startedAt,
        sourceDigest: digest("signed-restart-source"),
        expiresAt: Number.MAX_SAFE_INTEGER,
        exercises: [1, 2, 3, 4].map((ordinal) => ({
          ordinal,
          lineId: digest(["signed-restart-line", ordinal]),
          language: "en",
        })),
      };
      initial.set(`studyBinding:${lessonId}`, {
        offer,
        offerHash: digest(offer),
        exercisesHash: studyExercisesHash([1, 2, 3, 4]),
        target,
        authorization: { id: authorizationId, issuedAt: 1799999999, target },
      });
      initial.set(`studyPublication:${lessonId}`, {
        telegramFence,
        target,
        result: {
          learner,
          enrollmentId: authorizationId,
          startedAt: "1799999999",
        },
      });
      await authority.selectV4(communityId, results, 6343);
      assert.ok(authority.alarm() !== null);
      assert.equal(initial.linkedStudyBindings.hasUnclassified(), false);
      const waiting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let calls = 0;
      const scoped = {
        ...env,
        COMMUNITY_ID: communityId,
        STUDY_TELEGRAM_AUTHORITY: {
          async fetch(url: string, init?: RequestInit) {
            calls++;
            assert.equal(url, "https://study-telegram.internal/check");
            const { fence, context } = JSON.parse(String(init?.body));
            assert.deepEqual(fence, telegramFence);
            assert.deepEqual(context, {
              communityId,
              lessonId,
              learner,
              startedAt,
              authorizationId,
              contract: results,
            });
            waiting.resolve();
            await release.promise;
            return Response.json({
              schema: "pirate.study.telegram-fence-observation/1",
              hash: fence.hash,
              contextHash: digest(context),
              allowed: true,
            });
          },
        },
      } as Env;
      enqueue(initial, "record_result", ref, results, "0x1234", 21000n);
      initial.set("fault:crash-before-broadcast", true);
      await assert.rejects(
        dispatch(
          scoped,
          initial,
          "record_result",
          ref,
          limits,
          legacyResultGate(scoped, initial),
        ),
        /simulated_crash_before_broadcast/,
      );
      const nonce = intentOf(initial, "record_result", ref)!.nonce!;
      assert.equal(txRow(initial, nonce)?.broadcast, "none");
      const raw = txRow(initial, nonce)?.raw;
      const restarted = currentOperatorAuthorityFixture({
        now: initial.now,
        rpcUrl: evm.rpcUrl,
        sources: authority.sources,
        original: initial,
      });
      owned.push(restarted);
      await restarted.initialize();
      const persisted: ResultStore = restarted.store;
      assert.deepEqual(
        persisted.get(`studyBinding:${lessonId}`),
        initial.get(`studyBinding:${lessonId}`),
      );
      assert.equal(calls, 0);
      assert.deepEqual(n.state.sent, []);
      await assert.rejects(
        dispatch(
          scoped,
          persisted,
          "record_result",
          ref,
          limits,
          legacyResultGate(
            { ...scoped, STUDY_TELEGRAM_AUTHORITY: undefined },
            persisted,
          ),
        ),
        /study_telegram_fence_unavailable/,
      );
      assert.deepEqual(n.state.sent, []);
      const retry = dispatch(
        scoped,
        persisted,
        "record_result",
        ref,
        limits,
        legacyResultGate(scoped, persisted),
      );
      await waiting.promise;
      recordTelegramStudyDenial(persisted, telegramFence);
      release.resolve();
      const row = await retry;
      assert.equal(row?.broadcast, "none");
      assert.ok(row?.withheld);
      assert.equal(row?.raw, raw);
      assert.deepEqual(n.state.sent, []);
      assert.equal(calls, 1);
      await recoverTransactions(
        scoped,
        persisted,
        async () => true,
        legacyResultGate(scoped, persisted),
      );
      assert.deepEqual(n.state.sent, []);
      assert.equal(calls, 1);
    } finally {
      for (const fixture of owned) fixture.close();
      n?.restore();
      globalThis.fetch = realFetch;
      await stopChain(evm);
    }
  },
);
