// Explicit RPC observations and real sender/authorization handlers. No network,
// new keys, provider or public chain; the fixed key is an existing local fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { accounts, keys } from "../harness/runtime.ts";
import { resultsV4Abi } from "../packages/protocol/learning-results-v4.ts";
import {
  acceptAuthorization,
  resumeAuthorizations,
  AUTHORIZATION_RELAY_WINDOW_S,
} from "../services/learning-authorization.ts";
import {
  reserveActivationSponsorship,
  chargeSponsorship,
  retireUnallocatedAuthorization,
} from "../services/sponsor-budget.ts";
import {
  dispatch,
  enqueue,
  intentOf,
  type TxRow,
} from "../services/operator-tx.ts";
import type { ResultStore } from "../services/learning-transactions.ts";
import type { Env } from "../services/runtime.ts";
const id = `0x${"ab".repeat(32)}` as Hex;
const freshId = `0x${"cd".repeat(32)}` as Hex;
const learner = accounts[5].address;
const target = {
  chainId: 31337,
  version: 4,
  contract: accounts[3].address.toLowerCase() as `0x${string}`,
} as const;
const signIn = { learner, nonce: freshId, issuedAt: 100n };
const signature = "0x11" as Hex;
const gas = { cap: 400n, gas: 9n, gasPrice: 10n, dataFee: 10n };
const caps = { total: 200n, perAccount: 200n, accounts: 1 };
const expiresAt = 100 + AUTHORIZATION_RELAY_WINDOW_S;
const pendingKey = `pendingAuthorization:${target.contract}:${id}`;
function fixture() {
  let rows = new Map<string, unknown>(),
    now = expiresAt + 1;
  const store: ResultStore = {
    get: <T>(key: string) => rows.get(key) as T | undefined,
    set: (k, v) => {
      rows.set(k, structuredClone(v));
    },
    delete: (k) => {
      rows.delete(k);
    },
    entries: (prefix) =>
      [...rows]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    transaction: <T>(fn: () => T) => {
      const prior = new Map(rows);
      try {
        return fn();
      } catch (e) {
        rows = prior;
        throw e;
      }
    },
    now: () => now,
  };
  const env = {
    RPC_URL: "http://fixture.invalid",
    PAYMENT_CHAIN_ID: "31337",
    RESULTS_V4_CONTRACT: target.contract,
    PRIVATE_KEY: keys[2],
    SPONSOR_CAP_WEI: "400",
    SPONSOR_GAS_PRICE_WEI: "10",
    SPONSOR_GAS_LIMIT: "9",
    SPONSOR_DATA_FEE_WEI: "10",
  } as Env;
  reserveActivationSponsorship(store, gas, caps, learner, id);
  store.set(pendingKey, {
    target,
    signIn: { ...signIn, issuedAt: "100" },
    signature,
  });
  return {
    store,
    env,
    setNow: (v: number) => {
      now = v;
    },
  };
}
function rpc(
  t: { mock: { method: Function } },
  onGas?: () => Promise<void> | void,
) {
  const methods: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init),
        value = (await request.json()) as {
          id: number;
          method: string;
          params: unknown[];
        };
      methods.push(value.method);
      let result: unknown;
      if (value.method === "eth_call") {
        const call = value.params[0] as { data: Hex };
        assert.equal(
          decodeFunctionData({ abi: resultsV4Abi, data: call.data })
            .functionName,
          "signInDigest",
        );
        result = encodeFunctionResult({
          abi: resultsV4Abi,
          functionName: "signInDigest",
          result: id,
        });
      } else if (value.method === "eth_gasPrice") {
        await onGas?.();
        result = "0x1";
      } else throw Error(`unexpected RPC: ${value.method}`);
      return Response.json({ jsonrpc: "2.0", id: value.id, result });
    },
  );
  return methods;
}
function assertFreed(store: ResultStore) {
  assert.equal(
    store.get(`sponsor:activation:account:${learner.toLowerCase()}`),
    undefined,
  );
  assert.deepEqual(store.get("sponsor:activation:ledger"), {
    total: "200",
    perAccount: "200",
    accounts: 1,
    usedAccounts: 0,
    committed: "0",
  });
  const general = store.get<{ reserved: string; spent: string }>(
    "sponsor:ledger",
  )!;
  assert.equal(general.reserved, "0");
  assert.equal(general.spent, "0");
  assert.equal(store.get(pendingKey), undefined);
  assert.equal(store.entries("intent:").length, 0);
}
test("a crash after reservation before enqueue retires atomically and lets a fresh sign-in use capacity", async (t) => {
  const f = fixture();
  const methods = rpc(t);
  await resumeAuthorizations(f.env, f.store);
  assert.deepEqual(
    methods,
    [],
    "expired journal recovery must work without RPC",
  );
  assertFreed(f.store);
  assert.equal(f.store.entries("tx:").length, 0);
  reserveActivationSponsorship(f.store, gas, caps, learner, freshId);
  f.setNow(expiresAt - 1); // A stale caller/clock rollback cannot revive the retired digest.
  await assert.rejects(
    acceptAuthorization(f.env, f.store, signIn, signature),
    /stale_sign_in/,
  );
  assert.deepEqual(methods, ["eth_call"]);
});
test("charged unallocated intents are removed before refund and cannot be dispatched later", async (t) => {
  const f = fixture();
  rpc(t);
  for (const kind of ["record_activate", "record_authorize"] as const) {
    enqueue(f.store, kind, id, target.contract, "0x", gas.gas);
    chargeSponsorship(f.store, gas, `${kind}:${id}`);
  }
  await assert.rejects(
    acceptAuthorization(f.env, f.store, signIn, signature),
    /stale_sign_in/,
  );
  assertFreed(f.store);
  assert.equal(
    await dispatch(f.env, f.store, "record_activate", id),
    undefined,
  );
  assert.equal(
    await dispatch(f.env, f.store, "record_authorize", id),
    undefined,
  );
});
test("expiry during the sender fee read retires an unallocated intent without spending", async (t) => {
  const f = fixture();
  f.setNow(expiresAt); // Inclusive last admissible second.
  enqueue(f.store, "record_authorize", id, target.contract, "0x", gas.gas);
  // The existing authorize calldata must match the resumed request.
  const { encodeFunctionData } = await import("viem");
  f.store.set(`intent:record_authorize:${id}`, {
    ...intentOf(f.store, "record_authorize", id)!,
    data: encodeFunctionData({
      abi: resultsV4Abi,
      functionName: "authorize",
      args: [signIn, signature],
    }),
  });
  f.store.set("op:nonce", 0);
  const methods = rpc(t, () => f.setNow(expiresAt + 1));
  await assert.rejects(
    acceptAuthorization(f.env, f.store, signIn, signature),
    /stale_sign_in/,
  );
  assertFreed(f.store);
  assert.equal(f.store.get("op:nonce"), 0);
  assert.equal(f.store.entries("tx:").length, 0);
  assert.deepEqual(methods, ["eth_call", "eth_gasPrice"]);
});
test("a sender already awaiting its fee read cannot allocate a retired intent", async (t) => {
  const f = fixture();
  enqueue(f.store, "record_activate", id, target.contract, "0x", gas.gas);
  chargeSponsorship(f.store, gas, `record_activate:${id}`);
  f.store.set("op:nonce", 0);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const resume = new Promise<void>((r) => {
    release = r;
  });
  rpc(t, async () => {
    entered();
    await resume;
  });
  const sending = dispatch(f.env, f.store, "record_activate", id);
  await waiting;
  retireUnallocatedAuthorization(f.store, gas, learner, id);
  f.store.delete(pendingKey);
  release();
  assert.equal(await sending, undefined);
  assertFreed(f.store);
  assert.equal(f.store.get("op:nonce"), 0);
});
test("allocated, signed, attempted, mined and orphan evidence never refund the activation charge or cohort slot", () => {
  for (const state of [
    "allocated",
    "signed",
    "attempted",
    "reverted",
    "orphan-row",
    "orphan-charge",
  ] as const) {
    const f = fixture();
    chargeSponsorship(f.store, gas, `record_activate:${id}`);
    if (state !== "orphan-charge") {
      if (state !== "orphan-row")
        f.store.set(`intent:record_activate:${id}`, {
          kind: "record_activate",
          ref: id,
          nonce: 0,
        });
      if (state !== "allocated")
        f.store.set("tx:0000000000", {
          nonce: 0,
          kind: "record_activate",
          ref: id,
          ...(state !== "orphan-row" ? { raw: "0x01", hash: freshId } : {}),
          ...(state === "attempted" ? { broadcast: "attempted" } : {}),
          mined: state === "reverted" ? { status: "reverted", block: 1 } : null,
        } as TxRow);
    }
    const before = f.store.get(
      `sponsor:activation:account:${learner.toLowerCase()}`,
    );
    assert.equal(
      retireUnallocatedAuthorization(f.store, gas, learner, id),
      false,
      state,
    );
    assert.deepEqual(
      f.store.get(`sponsor:activation:account:${learner.toLowerCase()}`),
      before,
      state,
    );
    assert.equal(
      f.store.get<{ state: string }>(
        `sponsor:reservation:record_activate:${id}`,
      )?.state,
      "charged",
      state,
    );
    assert.equal(
      f.store.get<{ spent: string }>("sponsor:ledger")?.spent,
      "100",
      state,
    );
    assert.throws(
      () => reserveActivationSponsorship(f.store, gas, caps, learner, freshId),
      /account_activation_pending/,
      state,
    );
  }
});
test("an interrupted retirement rolls back refunds, intent removal and the account slot together", () => {
  const f = fixture();
  const before = f.store.entries("");
  const broken: ResultStore = {
    ...f.store,
    set(k, v) {
      if (k === "sponsor:activation:ledger")
        throw Error("fixture retirement persistence failure");
      f.store.set(k, v);
    },
  };
  assert.throws(
    () => retireUnallocatedAuthorization(broken, gas, learner, id),
    /persistence failure/,
  );
  assert.deepEqual(f.store.entries(""), before);
});

test("expired allocated authorization remains receipt-only and never returns cohort capacity", async (t) => {
  const f = fixture();
  const methods = rpc(t);
  f.store.set(`intent:record_authorize:${id}`, {
    kind: "record_authorize",
    ref: id,
    nonce: 0,
  });
  f.store.set("tx:0000000000", {
    nonce: 0,
    kind: "record_authorize",
    ref: id,
    chainId: 31337,
    to: target.contract,
    data: "0x",
    gas: "9",
    gasPrice: "10",
    hash: freshId,
    raw: "0x01",
    mined: null,
  } satisfies TxRow);
  chargeSponsorship(f.store, gas, `record_authorize:${id}`);
  assert.deepEqual(
    await acceptAuthorization(f.env, f.store, signIn, signature),
    { id, state: "pending", txHash: freshId },
  );
  assert.equal(
    f.store.get<{ state: string }>(`sponsor:reservation:record_authorize:${id}`)
      ?.state,
    "charged",
  );
  assert.ok(f.store.get(`sponsor:activation:account:${learner.toLowerCase()}`));
  assert.deepEqual(methods, ["eth_call"]);
});
