// UNRUN: actual sender + production SQLite Store; explicit scripted RPC only.
// Reuses the public fixed key from harness/runtime.ts. No chain/provider/port.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keccak256,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
} from "viem";
import { resultsV4Abi } from "../packages/protocol/learning-results-v4.ts";
import { recover } from "../services/karaoke.ts";
import { source } from "./learning-linked-withdrawal-fixture.ts";
import { keys } from "../harness/runtime.ts";
import {
  dispatch,
  enqueue,
  intentOf,
  txRow,
  type SendGate,
} from "../services/operator-tx.ts";
import { legacyResultGate } from "../services/learning-transactions.ts";
import {
  stageLinkedWithdrawal,
  discoverLinkedWithdrawal,
} from "../services/study-linked-withdrawal.ts";
import {
  headKey,
  LinkedWithdrawalPending,
  type WithdrawalHead,
} from "../services/study-linked-withdrawal-contract.ts";
import type { Env } from "../services/runtime.ts";
import {
  linkedFixture,
  scope,
  target,
  communityId,
  boot,
  prove,
} from "./learning-linked-withdrawal-fixture.ts";
function rpc() {
  const saved = globalThis.fetch,
    sent: Hex[] = [];
  let receipt: unknown = null,
    safeReads = 0;
  const chain = { cutoff: 500n, nonce: 1n };
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init?.body));
    let result: unknown;
    switch (method) {
      case "eth_chainId":
        result = "0x7a69";
        break;
      case "eth_getCode":
        result = "0x6000";
        break;
      case "eth_getBlockByNumber":
        if (params[0] === "safe") safeReads++;
        result = {
          number: "0x64",
          hash: keccak256("0x6000"),
          timestamp: "0x3e8",
          transactions: [],
        };
        break;
      case "eth_call": {
        const call = decodeFunctionData({
          abi: resultsV4Abi,
          data: params[0].data,
        });
        switch (call.functionName) {
          case "VERSION":
            result = encodeFunctionResult({
              abi: resultsV4Abi,
              functionName: "VERSION",
              result: 4,
            });
            break;
          case "communityId":
            result = encodeFunctionResult({
              abi: resultsV4Abi,
              functionName: "communityId",
              result: communityId,
            });
            break;
          case "revokedAt":
            result = encodeFunctionResult({
              abi: resultsV4Abi,
              functionName: "revokedAt",
              result: chain.cutoff,
            });
            break;
          case "nextNonce":
            result = encodeFunctionResult({
              abi: resultsV4Abi,
              functionName: "nextNonce",
              result: chain.nonce,
            });
            break;
          default:
            throw Error("unscripted contract read");
        }
        break;
      }
      case "eth_gasPrice":
        result = "0x1";
        break;
      case "eth_getTransactionCount":
        result = "0x0";
        break;
      case "eth_blockNumber":
        result = "0x64";
        break;
      case "eth_getTransactionReceipt":
        result = receipt;
        break;
      case "eth_getTransactionByHash":
        result = sent.length ? { hash: keccak256(sent[0]) } : null;
        break;
      case "eth_sendRawTransaction":
        sent.push(params[0]);
        result = keccak256(params[0]);
        break;
      default:
        throw Error("unscripted RPC " + method);
    }
    return Response.json({ jsonrpc: "2.0", id, result });
  }) as typeof fetch;
  return {
    sent,
    chain,
    safeReads: () => safeReads,
    mine: () => {
      receipt = {
        status: "0x1",
        blockNumber: "0x64",
        transactionHash: keccak256(sent[0]),
        logs: [],
      };
    },
    restore: () => {
      globalThis.fetch = saved;
    },
  };
}
async function fixture() {
  const f = linkedFixture(),
    store = f.store(),
    binding = f.binding(1),
    ref = "study:" + binding.offer.lessonId + ":1";
  store.set("studyBinding:" + binding.offer.lessonId, binding);
  await boot(store);
  store.set("studyPublication:" + binding.offer.lessonId, {
    target,
    telegramFence: binding.offer.telegramFence,
    result: {
      learner: scope.learner,
      enrollmentId: binding.authorization.id,
      startedAt: "900",
    },
  });
  const env = {
    RPC_URL: "http://fixture.invalid",
    PAYMENT_CHAIN_ID: "31337",
    PRIVATE_KEY: keys[2],
    COMMUNITY_ID: communityId,
    SPONSOR_CAP_WEI: "100000000000000",
    SPONSOR_GAS_PRICE_WEI: "1000",
    SPONSOR_GAS_LIMIT: "100000",
    SPONSOR_DATA_FEE_WEI: "0",
    STUDY_TELEGRAM_AUTHORITY: {
      async fetch(_input: unknown, init?: RequestInit) {
        const { fence, context } = JSON.parse(String(init?.body));
        return Response.json({
          schema: "pirate.study.telegram-fence-observation/1",
          hash: fence.hash,
          contextHash: (await import("../packages/protocol/index.ts")).digest(
            context,
          ),
          allowed: true,
        });
      },
    },
  } as unknown as Env;
  enqueue(store, "record_result", ref, target.contract, "0x1234", 21000n);
  const stage = () =>
    store.transaction(() =>
      stageLinkedWithdrawal(store, {
        id: "withdrawal",
        scope,
        kind: "observed",
        identity: { cutoff: 500, nonce: "1" },
      }),
    );
  return { ...f, store, binding, ref, env, stage };
}
for (const point of [
  "allocation",
  "signed",
  "final synchronous guard",
] as const)
  test(`pending withdrawal at ${point} sends nothing and retains an uncertain original`, async () => {
    const node = rpc(),
      f = await fixture();
    try {
      const real = legacyResultGate(f.env, f.store);
      let gate: SendGate = real;
      if (point === "signed") {
        f.store.set("fault:crash-before-broadcast", true);
        await assert.rejects(
          dispatch(f.env, f.store, "record_result", f.ref, undefined, real),
          /simulated_crash_before_broadcast/,
        );
        f.stage();
      } else if (point === "allocation") f.stage();
      else
        gate = {
          ...real,
          withheld: async (kind, ref) => {
            const withheld = await real.withheld(kind, ref);
            f.stage();
            return withheld;
          },
        };
      const nonce = intentOf(f.store, "record_result", f.ref)!.nonce,
        original = nonce === null ? undefined : txRow(f.store, nonce);
      await assert.rejects(
        dispatch(f.env, f.store, "record_result", f.ref, undefined, gate),
        LinkedWithdrawalPending,
      );
      assert.deepEqual(node.sent, []);
      const allocated = intentOf(f.store, "record_result", f.ref)!.nonce;
      if (point === "allocation") assert.equal(allocated, null);
      else {
        const row = txRow(f.store, allocated!)!;
        assert.equal(row.broadcast, "none");
        assert.equal(row.withheld, undefined);
        if (original) {
          assert.equal(row.raw, original.raw);
          assert.equal(row.hash, original.hash);
          assert.equal(row.nonce, original.nonce);
        }
      }
    } finally {
      node.restore();
      f.close();
    }
  });
test("attempted original remains receipt-only after permanent original denial with unchanged bytes/hash/nonce", async () => {
  const node = rpc(),
    f = await fixture();
  try {
    const gate = legacyResultGate(f.env, f.store);
    await dispatch(f.env, f.store, "record_result", f.ref, undefined, gate);
    const nonce = intentOf(f.store, "record_result", f.ref)!.nonce!,
      original = txRow(f.store, nonce)!;
    assert.equal(original.broadcast, "attempted");
    assert.equal(node.sent.length, 1);
    f.stage();
    prove(f.store, "withdrawal", 500);
    discoverLinkedWithdrawal(
      f.store,
      scope,
      f.store.get<WithdrawalHead>(headKey(scope))!.revision,
    );
    await dispatch(f.env, f.store, "record_result", f.ref, undefined, gate);
    assert.equal(node.sent.length, 1);
    node.mine();
    await dispatch(f.env, f.store, "record_result", f.ref, undefined, gate);
    const reconciled = txRow(f.store, nonce)!;
    assert.equal(reconciled.mined?.status, "success");
    assert.equal(reconciled.raw, original.raw);
    assert.equal(reconciled.hash, original.hash);
    assert.equal(reconciled.nonce, original.nonce);
    assert.equal(node.sent.length, 1);
  } finally {
    node.restore();
    f.close();
  }
});

test("actual /recover observes a due withdrawal before the general recovery sender", async () => {
  const node = rpc(),
    f = await fixture();
  try {
    Object.assign(f.env, {
      RESULTS_V4_CONTRACT: target.contract,
      STUDY_WITHDRAWAL_SOURCES_JSON: JSON.stringify([source]),
    });
    const jobKey = "studyPublication:" + f.binding.offer.lessonId,
      job = f.store.get<Record<string, unknown>>(jobKey)!;
    f.store.set(jobKey, {
      ...job,
      data: "0x1234",
      receipt: { state: "pending" },
      privateHistoryExpiresAt: 9999999999999,
      lastTriedAt: 0,
      result: { ...(job.result as object), completedAt: "901" },
    });
    f.store.set("fault:crash-before-broadcast", true);
    await assert.rejects(
      dispatch(
        f.env,
        f.store,
        "record_result",
        f.ref,
        undefined,
        legacyResultGate(f.env, f.store),
      ),
      /simulated_crash_before_broadcast/,
    );
    const nonce = intentOf(f.store, "record_result", f.ref)!.nonce!,
      original = txRow(f.store, nonce)!;
    await assert.rejects(recover(f.env, f.store), LinkedWithdrawalPending);
    assert.ok(node.safeReads() > 0);
    assert.equal(f.store.get<WithdrawalHead>(headKey(scope))!.cutoffS, 500);
    assert.equal(node.sent.includes(original.raw!), false);
    assert.equal(txRow(f.store, nonce)!.raw, original.raw);
    assert.equal(txRow(f.store, nonce)!.broadcast, "none");
  } finally {
    node.restore();
    f.close();
  }
});
test("actual /recover progresses a retained pending proof before entering general transaction recovery", async () => {
  const node = rpc(),
    f = await fixture();
  try {
    Object.assign(f.env, {
      RESULTS_V4_CONTRACT: target.contract,
      STUDY_WITHDRAWAL_SOURCES_JSON: JSON.stringify([source]),
    });
    stageLinkedWithdrawal(f.store, {
      id: "already-pending",
      scope,
      kind: "observed",
      identity: { cutoff: "800", nonce: "2" },
    });
    node.chain.cutoff = 800n;
    node.chain.nonce = 2n;
    const entries = f.store.entries.bind(f.store);
    f.store.entries = (prefix: string) => {
      if (prefix === "intent:") {
        assert.equal(
          f.store.get<WithdrawalHead>(headKey(scope))!.openProofs,
          0,
        );
        throw Error("observed general-sender boundary");
      }
      return entries(prefix);
    };
    await assert.rejects(
      recover(f.env, f.store),
      /observed general-sender boundary/,
    );
    assert.ok(node.safeReads() > 0);
    assert.equal(f.store.get<WithdrawalHead>(headKey(scope))!.cutoffS, 800);
    assert.deepEqual(node.sent, []);
  } finally {
    node.restore();
    f.close();
  }
});
