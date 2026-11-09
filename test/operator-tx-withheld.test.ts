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
  recoverTransactions,
  txRow,
  withheldUnpublished,
  type SendGate,
  type TxRow,
  type TxStore,
} from "../services/operator-tx.ts";
import type { Env } from "../services/runtime.ts";
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
/** A scripted node: every request body is kept, sends are recorded, mining is explicit. */
function node() {
  const real = globalThis.fetch;
  const state = {
    bodies: [] as string[],
    sent: [] as Hex[],
    priced: [] as Hex[],
    latest: 0,
    receipts: new Map<Hex, { status: Hex; blockNumber: Hex; transactionHash: Hex; logs: [] }>(),
    mineSends: true,
    gasPrice: 10n ** 9n,
  };
  const mine = (raw: Hex) => {
    const hash = keccak256(raw);
    state.receipts.set(hash, { status: "0x1", blockNumber: "0x10", transactionHash: hash, logs: [] });
    state.latest += 1;
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
        return reply("0x20");
      case "eth_call": {
        // GasPriceOracle.getL1Fee(bytes): record what was priced, answer 0.
        const data = params[0].data as Hex;
        const [priced] = (await import("viem")).decodeAbiParameters([{ type: "bytes" }], `0x${data.slice(10)}`);
        state.priced.push(priced as Hex);
        return reply(encodeAbiParameters([{ type: "uint256" }], [0n]));
      }
      case "eth_getTransactionReceipt":
        return reply(state.receipts.get(params[0]) ?? null);
      case "eth_sendRawTransaction":
        state.sent.push(params[0]);
        if (state.mineSends) mine(params[0]);
        return reply(keccak256(params[0]));
    }
    throw new Error(`unscripted ${method}`);
  }) as typeof fetch;
  return { state, mine, restore: () => void (globalThis.fetch = real) };
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
    const settled = (await dispatch(env, store, "record_result", "ticket:1", limits, gate({ value: true })))!;
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

test("a withheld row whose nonce another transaction consumed is superseded, and recovery continues past it", async () => {
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
    // Something else consumes nonce 0; the payment then mines.
    n.state.mineSends = true;
    n.state.latest = 1;
    const reconciled = await warnings(() => recoverTransactions(env, store, async () => true, gate({ value: true })));
    assert.ok(reconciled.some((l) => l.includes("operator_nonce_superseded")));
    const superseded = txRow(store, 0)!;
    assert.equal(superseded.mined?.status, "superseded");
    assert.equal(superseded.raw, row.raw);
    assert.equal(superseded.hash, row.hash);
    assert.equal(withheldUnpublished(superseded), true);
    assert.equal(txRow(store, 1)!.mined?.status, "success");
    assert.equal(n.state.sent.includes(row.raw!), true, "sent once, before the withdrawal");
    assert.equal(n.state.sent.filter((raw) => raw === row.raw).length, 1);
  } finally {
    n.restore();
  }
});
