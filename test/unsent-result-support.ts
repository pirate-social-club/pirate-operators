// Shared by the Karaoke and Study withheld-result tests: JSON-RPC
// interception, the dispatch failures that leave a V3 result unsent, and the
// assertions on the operator's journal. Local anvil only.
import assert from "node:assert/strict";
import { toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import { accounts } from "../harness/runtime.ts";
import {
  dispatch,
  enqueue,
  intentOf,
  maximumFee,
  txRow,
  type TxRow,
} from "../services/operator-tx.ts";
import type { ResultStore } from "../services/learning-transactions.ts";
import type { Env } from "../services/runtime.ts";

export const learnerIndex = 5;
export const learner = accounts[learnerIndex]!.address as Address;
export const operator = accounts[2]!.address as Address;

type Hook = (method: string, params: unknown[]) => unknown;
/**
 * Watches every JSON-RPC call made through fetch. A hook answers a call by
 * returning a result, fails it by throwing, or passes it by returning
 * undefined. Every raw transaction sent is recorded.
 */
export function rpcWatch() {
  const real = globalThis.fetch;
  const sent: Hex[] = [];
  const hooks: Hook[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    let call: { id?: number; method?: string; params?: unknown[] } | undefined;
    try {
      call = JSON.parse(body);
    } catch {
      call = undefined;
    }
    if (call?.method) {
      for (const hook of [...hooks]) {
        const answer = await hook(call.method, call.params ?? []);
        if (answer !== undefined)
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: call.id ?? 1, result: answer }),
            { headers: { "content-type": "application/json" } },
          );
      }
      if (
        call.method === "eth_sendRawTransaction" ||
        call.method === "realtime_sendRawTransaction"
      )
        sent.push((call.params as Hex[])[0]!);
    }
    return real(input, init);
  }) as typeof fetch;
  return {
    sent,
    /** Adds a hook that applies to the next `times` calls of `method`. */
    on(method: string, answer: () => unknown, times = 1) {
      let left = times;
      const hook: Hook = (m) => {
        if (m !== method || left <= 0) return undefined;
        left--;
        if (left === 0) hooks.splice(hooks.indexOf(hook), 1);
        return answer();
      };
      hooks.push(hook);
    },
    clear() {
      hooks.length = 0;
    },
    restore() {
      globalThis.fetch = real;
    },
  };
}
export type Watch = ReturnType<typeof rpcWatch>;

/**
 * A dispatch failure that leaves the result unsent. All but `crash` fail
 * before a nonce is allocated; `allocation` fails inside the allocation
 * transaction, which rolls back with its nonce.
 */
export type Fault = "outage" | "price" | "total" | "allocation" | "crash";
export const faults: Fault[] = [
  "outage",
  "price",
  "total",
  "allocation",
  "crash",
];
export const faultName: Record<Fault, string> = {
  outage: "an eth_gasPrice failure",
  price: "gas_price_above_limit",
  total: "total_fee_limit",
  allocation: "a failure inside nonce allocation",
  crash: "a crash after signing, before broadcast",
};
const faultError: Record<Fault, RegExp> = {
  outage: /fixture gas price outage|fetch|HTTP request failed/i,
  price: /gas_price_above_limit/,
  total: /total_fee_limit/,
  allocation: /simulated_allocation_failure/,
  crash: /simulated_crash_before_broadcast/,
};

/**
 * Other operator work, sent outside sponsorship, that has used the journal's
 * whole fee ceiling, so the next sponsored allocation meets total_fee_limit.
 */
async function spendFeeCeiling(env: Env, store: ResultStore) {
  const cap = BigInt(env.SPONSOR_CAP_WEI!),
    gas = 20_000_000n;
  const price = (cap + gas - 1n) / gas;
  const watch = rpcWatch();
  watch.on("eth_gasPrice", () => "0x" + price.toString(16));
  try {
    enqueue(store, "close", "fixture-fee-ceiling", operator, "0x", gas);
    let row = await dispatch(env, store, "close", "fixture-fee-ceiling");
    for (let i = 0; !row?.mined && i < 5; i++)
      row = await dispatch(env, store, "close", "fixture-fee-ceiling");
    assert.equal(row?.mined?.status, "success");
    assert.ok(maximumFee(row!) >= cap);
  } finally {
    watch.restore();
  }
  // Empty blocks, so the node's fee suggestion is back to normal.
  const call = (method: string, params: unknown[]) =>
    fetch(env.RPC_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then(async (r) => ((await r.json()) as { result: Hex }).result);
  await call("anvil_mine", ["0x40"]);
  assert.ok(
    BigInt(await call("eth_gasPrice", [])) <= BigInt(env.SPONSOR_GAS_PRICE_WEI!),
  );
}

/** Runs `send` under `fault` and checks the unsent state it leaves. */
export async function injectFault(
  fault: Fault,
  env: Env,
  store: ResultStore,
  ref: string,
  send: () => Promise<unknown>,
) {
  if (fault === "total") await spendFeeCeiling(env, store);
  const watch = rpcWatch();
  if (fault === "outage")
    watch.on("eth_gasPrice", () => {
      throw new TypeError("fixture gas price outage");
    });
  if (fault === "price")
    watch.on(
      "eth_gasPrice",
      () => "0x" + (BigInt(env.SPONSOR_GAS_PRICE_WEI!) * 10n).toString(16),
    );
  if (fault === "allocation") store.set("fault:fail-allocation", true);
  if (fault === "crash") store.set("fault:crash-before-broadcast", true);
  try {
    await assert.rejects(send(), faultError[fault]);
  } finally {
    watch.restore();
  }
  assert.deepEqual(watch.sent, []);
  // The operator raises its ceiling, so only the withdrawal can stop the result.
  if (fault === "total")
    env.SPONSOR_CAP_WEI = String(BigInt(env.SPONSOR_CAP_WEI!) * 4n);
  const intent = intentOf(store, "record_result", ref);
  assert.ok(intent, "the result transaction is queued");
  if (fault !== "crash") {
    assert.equal(intent.nonce, null);
    return undefined;
  }
  assert.notEqual(intent.nonce, null);
  const row = txRow(store, intent.nonce!)!;
  assert.equal(row.broadcast, "none");
  assert.ok(row.raw && row.hash);
  return structuredClone(row);
}

/** The settings route at the operator: the learner's signed V4 Revocation, relayed. */
export async function revokeThroughOperator(
  env: Env,
  store: ResultStore,
  accept: typeof import("../services/learning-authorization.ts").acceptRevocationV4,
  request: typeof import("../services/learning-authorization.ts").revocationRequestV4,
) {
  const typed = await request(env, learner);
  const signature = await accounts[learnerIndex]!.signTypedData(typed as never);
  // Behind an unmined result nonce it stays pending; the marker is set at once.
  await accept(env, store, learner, BigInt(typed.message.nonce), signature);
  assert.ok(
    store.get(`legacyResultsWithheld:${learner.toLowerCase()}`) !== undefined,
  );
}
/** The direct route: the learner's own `revoke` call on V4. */
export async function revokeDirectly(
  evm: {
    read: (...args: never[]) => Promise<unknown>;
    write: (...args: never[]) => Promise<unknown>;
  },
  v4: Address,
) {
  const read = evm.read as (a: Address, c: string, f: string, x: unknown[]) => Promise<unknown>;
  const write = evm.write as (a: Address, c: string, f: string, x: unknown[], i: number) => Promise<unknown>;
  const nonce = await read(v4, "LearningResultsV4", "nextNonce", [learner]);
  await write(v4, "LearningResultsV4", "revoke", [learner, nonce, "0x"], learnerIndex);
  assert.ok(((await read(v4, "LearningResultsV4", "revokedAt", [learner])) as bigint) > 0n);
}

/**
 * The journal after the withdrawal was handled. Never allocated: no intent,
 * no row, the sponsorship refunded. Allocated and never sent: the row and
 * its evidence kept, its own bytes never sent, the nonce consumed on chain
 * by a zero-value transfer to the operator recorded as a cancellation, and
 * the fee counted once, by the cancellation.
 */
export async function assertWithheldJournal(
  store: ResultStore,
  client: PublicClient,
  ref: string,
  allocated: TxRow | undefined,
  sent: Hex[],
) {
  const reservation = store.get<{ state: string; amount: string }>(
    `sponsor:reservation:record_result:${ref}`,
  );
  if (!allocated) {
    assert.equal(intentOf(store, "record_result", ref), undefined);
    assert.deepEqual(
      store.entries("tx:").filter(({ value }) => (value as TxRow).ref === ref),
      [],
    );
    assert.equal(reservation?.state, "released");
    return;
  }
  assert.ok(!sent.includes(allocated.raw!), "the withheld bytes were sent");
  assert.equal(intentOf(store, "record_result", ref)?.nonce, allocated.nonce);
  const row = txRow(store, allocated.nonce)!;
  for (const field of ["kind", "ref", "to", "data", "gas", "gasPrice", "raw", "hash", "nonce"] as const)
    assert.equal(row[field], allocated[field], `evidence ${field} kept`);
  assert.equal(row.broadcast, "none");
  assert.equal(row.withheld?.reason, "authorization_withdrawn");
  assert.equal(row.mined?.status, "cancelled");
  const cancellation = row.cancellation!;
  assert.equal(cancellation.status, "success");
  assert.equal(cancellation.to, operator);
  assert.ok(sent.includes(cancellation.raw!));
  const tx = await client.getTransaction({ hash: cancellation.hash! });
  assert.equal(tx.nonce, allocated.nonce);
  assert.equal(tx.from.toLowerCase(), operator.toLowerCase());
  assert.equal(tx.to?.toLowerCase(), operator.toLowerCase());
  assert.equal(tx.value, 0n);
  assert.equal(tx.input, "0x");
  assert.equal(tx.type, "legacy");
  const mined = await client.getTransactionReceipt({ hash: cancellation.hash! });
  assert.equal(mined.status, "success");
  assert.equal(Number(mined.blockNumber), row.mined!.block);
  // Counted once: the row's fee is its cancellation's, within the one charge.
  assert.equal(
    maximumFee(row),
    BigInt(cancellation.gas) * BigInt(cancellation.gasPrice),
  );
  assert.equal(reservation?.state, "charged");
  assert.ok(maximumFee(row) <= BigInt(reservation!.amount));
  await assertNonceAccounting(store, client);
}
/** Every allocated nonce is consumed on chain and the next one is the journal's. */
export async function assertNonceAccounting(
  store: ResultStore,
  client: PublicClient,
) {
  const unmined = store
    .entries("tx:")
    .filter(({ value }) => !(value as TxRow).mined);
  assert.deepEqual(unmined, []);
  const next = store.get<number>("op:nonce");
  assert.equal(
    await client.getTransactionCount({ address: operator, blockTag: "latest" }),
    next,
  );
  assert.equal(
    await client.getTransactionCount({ address: operator, blockTag: "pending" }),
    next,
  );
}
/** Captures the operator's warnings while `run` executes. */
export async function warnings(run: () => Promise<unknown>) {
  const real = console.warn;
  const seen: string[] = [];
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = real;
  }
  return seen;
}

const revokedAtSelector = toFunctionSelector("revokedAt(address)").slice(2);
/**
 * Runs `during` once, at the first matching JSON-RPC call made while `when`
 * holds, before that call goes out: the pre-send receipt read
 * (eth_getTransactionReceipt) or the V4 `revokedAt` read just before a send.
 */
export function interceptOnce(
  at: "receipt" | "revokedAt",
  during: () => Promise<unknown>,
  when: () => boolean,
) {
  const real = globalThis.fetch;
  let fired = false,
    busy = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const matches =
      at === "receipt"
        ? body.includes('"eth_getTransactionReceipt"')
        : body.includes('"eth_call"') && body.includes(revokedAtSelector);
    if (!busy && !fired && matches && when()) {
      fired = busy = true;
      try {
        await during();
      } finally {
        busy = false;
      }
    }
    return real(input, init);
  }) as typeof fetch;
  return {
    fired: () => fired,
    restore() {
      globalThis.fetch = real;
    },
  };
}
/** The result's own row, allocated, signed and not yet sent or withheld. */
export function unsentRow(store: ResultStore, ref: string) {
  const nonce = intentOf(store, "record_result", ref)?.nonce;
  const row = nonce == null ? undefined : txRow(store, nonce);
  return row?.raw && row.broadcast === "none" && !row.withheld && !row.mined
    ? row
    : undefined;
}
/** The operator's own self-transfer at `nonce`, sent outside the operator's journal. */
export async function consumeNonceExternally(
  evm: { rpc: (method: string, params: unknown[]) => Promise<unknown> },
  chainId: number,
  nonce: number,
) {
  const raw = await accounts[2]!.signTransaction({
    type: "legacy",
    chainId,
    nonce,
    to: operator,
    value: 0n,
    gas: 21000n,
    gasPrice: 10n ** 10n,
  });
  await evm.rpc("eth_sendRawTransaction", [raw]);
  await evm.rpc("evm_mine", []);
  return raw;
}
