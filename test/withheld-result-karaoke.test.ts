// A V3 Karaoke result whose dispatch failed before it was sent stays private
// after the learner withdraws under V4, by settings or by their own `revoke`
// call, whether the next attempt is the publication retry or background
// recovery. A transaction never allocated is withdrawn and refunded; one
// allocated but provably never sent is replaced at its nonce by a recorded
// cancellation. A transaction that may already have been sent is never sent
// again after the withdrawal is observed; only its receipt is reconciled.
// Local V3 and V4 contracts on anvil and an in-memory journal.
import test from "node:test";
import assert from "node:assert/strict";
import { zeroHash, type Hex } from "viem";
import { accounts } from "../harness/runtime.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  acceptRevocationV4,
  revocationRequestV4,
} from "../services/learning-authorization.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  acceptEnrollment,
  publicationV2,
  publishV2,
} from "../services/learning-results.ts";
import {
  dispatch,
  enqueue,
  intentOf,
  txRow,
  type TxRow,
} from "../services/operator-tx.ts";
import { readFile } from "node:fs/promises";
import {
  recoverLearningTransactions,
  settleWithheldLearningTransactions,
} from "../services/study-publication-recovery.ts";
/** What the operator's regular alarm runs for withheld rows on every tick. */
const alarm = async (c: { k: { env: never; store: never; evm: never } }) => {
  await mineDepth(c.k.evm);
  await settleWithheldLearningTransactions(c.k.env, c.k.store);
};
import { learningBindingFixture } from "./learning-binding-fixture.ts";
import {
  assertNonceAccounting,
  assertWithheldJournal,
  faultName,
  faults,
  injectFault,
  mineDepth,
  interceptOnce,
  consumeNonceExternally,
  unsentRow,
  revokeDirectly,
  revokeThroughOperator,
  rpcWatch,
  warnings,
  operator,
  type Fault,
} from "./unsent-result-support.ts";

type Route = "settings" | "direct";
/** Private and withheld; a re-checked state also carries when it was read. */
function assertPrivateState(store: Parameters<typeof publicationV2>[0], id: string) {
  const state = publicationV2(store, id)!;
  assert.deepEqual(
    { state: state.state, revision: state.revision, reason: (state as { reason?: string }).reason },
    { state: "private", revision: 1, reason: "authorization_withdrawn" },
  );
}
let port = 19800;

/** A finished, enrollment-bound V3 run and a V4 contract for the community. */
async function karaoke(fill: string) {
  const communityId = `0x${fill.repeat(32)}` as Hex;
  const k = await learningBindingFixture(port++, communityId);
  k.env.RESULTS_V3_CONTRACT = k.v3;
  const enrollment = await k.enrollment(3);
  let enrolled = await acceptEnrollment(k.env, k.store, enrollment.e, enrollment.signature);
  for (let i = 0; !enrolled?.mined && i < 5; i++)
    enrolled = await acceptEnrollment(k.env, k.store, enrollment.e, enrollment.signature);
  assert.equal(enrolled?.mined?.status, "success");
  const run = await k.prepare(`withheld-run-${fill}`);
  const result = await k.finish(run);
  const v4 = await k.evm.deploy("LearningResultsV4", [
    accounts[3].address,
    communityId,
    learningV4PublicityPolicy,
    firstSong.origin,
  ]);
  k.env.RESULTS_V4_CONTRACT = v4;
  const id = run.ticket.ticketId;
  return { k, v4, id, ref: `${id}:1`, session: result.attemptId as Hex };
}
type Karaoke = Awaited<ReturnType<typeof karaoke>>;
const withdraw = (c: Karaoke, route: Route) =>
  route === "settings"
    ? revokeThroughOperator(c.k.env, c.k.store, acceptRevocationV4, revocationRequestV4)
    : revokeDirectly(c.k.evm as never, c.v4);
const retry = async (c: Karaoke) => {
  for (let i = 0; i < 3; i++) await publishV2(c.k.env, c.k.store, c.id);
};
/** Background recovery, each pass after the settlement depth has passed. */
const recover = async (c: Karaoke) => {
  for (let i = 0; i < 3; i++) {
    await mineDepth(c.k.evm);
    await recoverLearningTransactions(c.k.env, c.k.store);
  }
};
async function nothingOnV3(c: Karaoke) {
  assert.equal(
    await c.k.evm.read(c.k.v3, "LearningResultsV3", "commitments", [c.session]),
    zeroHash,
  );
}

let fill = 0x20;
for (const fault of faults)
  for (const route of ["settings", "direct"] as Route[])
    for (const first of ["retry", "recovery"] as const)
      test(
        `Karaoke: after ${faultName[fault]}, a ${route} withdrawal keeps the V3 result unpublished, with ${first} first`,
        { timeout: 180000 },
        async () => {
          const c = await karaoke((fill++).toString(16));
          const watch = rpcWatch();
          try {
            const allocated = await injectFault(fault as Fault, c.k.env, c.k.store, c.ref, () =>
              publishV2(c.k.env, c.k.store, c.id),
            );
            await withdraw(c, route);
            if (first === "retry") {
              await retry(c);
              await recover(c);
            } else {
              await recover(c);
              await retry(c);
            }
            await recover(c);
            assertPrivateState(c.k.store, c.id);
            await nothingOnV3(c);
            await assertWithheldJournal(c.k.store, c.k.evm.publicClient as never, c.ref, allocated, watch.sent);
            await assertNonceAccounting(c.k.store, c.k.evm.publicClient as never);
          } finally {
            watch.restore();
            await c.k.stop();
          }
        },
      );

test(
  "Karaoke: a withdrawal accepted while the dispatch waits for its fee read stops the allocation",
  { timeout: 180000 },
  async () => {
    const c = await karaoke("e1");
    // The withdrawal lands while the result's dispatch awaits eth_gasPrice.
    const realFetch = globalThis.fetch;
    let fired = false,
      busy = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!busy && !fired && body.includes('"eth_gasPrice"')) {
        fired = busy = true;
        try {
          await withdraw(c, "settings");
        } finally {
          busy = false;
        }
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const watch = rpcWatch();
    try {
      try {
        await publishV2(c.k.env, c.k.store, c.id);
      } finally {
        watch.restore();
        globalThis.fetch = realFetch;
      }
      assert.equal(fired, true);
      assert.equal(intentOf(c.k.store, "record_result", c.ref)?.nonce, null);
      await retry(c);
      await recover(c);
      assert.equal(publicationV2(c.k.store, c.id)?.state, "private");
      assert.equal(intentOf(c.k.store, "record_result", c.ref), undefined);
      await nothingOnV3(c);
      await assertNonceAccounting(c.k.store, c.k.evm.publicClient as never);
    } finally {
      await c.k.stop();
    }
  },
);

test(
  "Karaoke: when the fee limits refuse the cancellation, nothing is sent and it waits",
  { timeout: 180000 },
  async () => {
    const c = await karaoke("e2");
    const watch = rpcWatch();
    try {
      const allocated = (await injectFault("crash", c.k.env, c.k.store, c.ref, () =>
        publishV2(c.k.env, c.k.store, c.id),
      ))!;
      await revokeDirectly(c.k.evm as never, c.v4);
      const above = "0x" + (BigInt(c.k.env.SPONSOR_GAS_PRICE_WEI!) * 10n).toString(16);
      watch.on("eth_gasPrice", () => above, 1000);
      const before = watch.sent.length;
      const logged = await warnings(async () => {
        await assert.rejects(publishV2(c.k.env, c.k.store, c.id), /gas_price_above_limit/);
        await recover(c);
        await retry(c);
      });
      assert.equal(watch.sent.length, before, "nothing was sent");
      const row = txRow(c.k.store, allocated.nonce)!;
      assert.equal(row.withheld?.reason, "authorization_withdrawn");
      assert.equal(row.cancellation, undefined);
      assert.equal(row.mined, null);
      assert.ok(logged.some((line) => line.includes("operator_cancellation_waiting")));
      // Proven never sent, it can never publish, even while the nonce waits.
      assert.equal(publicationV2(c.k.store, c.id)?.state, "private");
      // The fee comes back within the limit; the regular alarm's tick, not
      // only /recover, then cancels the nonce.
      watch.clear();
      await alarm(c as never); // sends the cancellation
      await alarm(c as never); // settles it once deep enough
      await nothingOnV3(c);
      await assertWithheldJournal(c.k.store, c.k.evm.publicClient as never, c.ref, allocated, watch.sent);
    } finally {
      watch.restore();
      await c.k.stop();
    }
  },
);

for (const origin of ["historical", "attempted"] as const)
  test(
    origin === "historical"
      ? "Karaoke: a journal row from before the broadcast marker is treated as possibly sent: never cancelled, never resent, its receipt reconciled"
      : "Karaoke: a row whose send was attempted is never resent after the withdrawal; only its receipt is reconciled",
    { timeout: 180000 },
    async () => {
      const c = await karaoke(origin === "historical" ? "e3" : "e4");
      const watch = rpcWatch();
      try {
        let original: Hex;
        let nonce: number;
        if (origin === "historical") {
          const allocated = (await injectFault("crash", c.k.env, c.k.store, c.ref, () =>
            publishV2(c.k.env, c.k.store, c.id),
          ))!;
          // As the journal held it before this change: no broadcast field.
          const row = txRow(c.k.store, allocated.nonce)!;
          delete row.broadcast;
          c.k.store.set(`tx:${String(row.nonce).padStart(10, "0")}`, row);
          original = row.raw!;
          nonce = row.nonce;
        } else {
          // The send is attempted; the node never answers, so its fate is unknown.
          watch.on("eth_sendRawTransaction", () => {
            throw new TypeError("fixture send outage");
          });
          await publishV2(c.k.env, c.k.store, c.id);
          const intent = intentOf(c.k.store, "record_result", c.ref)!;
          const row = txRow(c.k.store, intent.nonce!)!;
          assert.equal(row.broadcast, "attempted");
          assert.equal(row.mined, null);
          original = row.raw!;
          nonce = row.nonce;
        }
        await withdraw(c, "settings");
        const sentBefore = watch.sent.length;
        const logged = await warnings(async () => {
          await retry(c);
          await recover(c);
        });
        // No further publication attempt after the withdrawal was observed.
        assert.ok(!watch.sent.slice(sentBefore).includes(original));
        const row = txRow(c.k.store, nonce)!;
        assert.equal(row.withheld?.reason, "authorization_withdrawn");
        assert.equal(row.cancellation, undefined);
        assert.equal(row.mined, null);
        assert.equal(publicationV2(c.k.store, c.id)?.state, "pending");
        const stuck = logged.find((line) => line.includes("operator_nonce_withheld"));
        assert.ok(stuck);
        assert.equal(JSON.parse(stuck).nonce, nonce);
        // Later operator work waits behind the open nonce.
        assert.ok(
          c.k.store.entries("tx:").some(({ value }) => (value as { nonce: number; mined: unknown }).nonce > nonce && !(value as { mined: unknown }).mined),
        );
        await nothingOnV3(c);
        // The earlier send reaches the chain after all: the receipt is
        // reconciled and the result is published, as it was sent before the
        // withdrawal.
        await c.k.evm.rpc("eth_sendRawTransaction", [original]);
        await c.k.evm.rpc("evm_mine", []);
        const external = watch.sent.length;
        await recover(c);
        await retry(c);
        assert.equal(txRow(c.k.store, nonce)!.mined?.status, "success");
        assert.equal(publicationV2(c.k.store, c.id)?.state, "published");
        assert.ok(!watch.sent.slice(external).includes(original));
        await assertNonceAccounting(c.k.store, c.k.evm.publicClient as never);
      } finally {
        watch.restore();
        await c.k.stop();
      }
    },
  );

for (const [route, at] of [
  ["settings", "receipt"],
  ["direct", "receipt"],
  ["settings", "revokedAt"],
] as const)
  test(
    `Karaoke: a ${route} withdrawal during the pre-send ${at} read keeps the original bytes from being sent`,
    { timeout: 180000 },
    async () => {
      const c = await karaoke(route === "direct" ? "f2" : at === "receipt" ? "f1" : "f3");
      let snapshot: ReturnType<typeof unsentRow>;
      // The settings Revocation is relayed behind the result's unsent nonce,
      // so the chain shows no withdrawal; only the operator's record does.
      const hook = interceptOnce(
        at,
        async () => {
          snapshot = structuredClone(unsentRow(c.k.store, c.ref));
          await withdraw(c, route);
        },
        () => !!unsentRow(c.k.store, c.ref),
      );
      const watch = rpcWatch();
      try {
        try {
          await publishV2(c.k.env, c.k.store, c.id);
        } finally {
          watch.restore();
          hook.restore();
        }
        assert.equal(hook.fired(), true);
        const all = rpcWatch();
        try {
          await retry(c);
          await recover(c);
          await recover(c);
        } finally {
          all.restore();
        }
        assertPrivateState(c.k.store, c.id);
        await nothingOnV3(c);
        await assertWithheldJournal(c.k.store, c.k.evm.publicClient as never, c.ref, snapshot!, [...watch.sent, ...all.sent]);
        await assertNonceAccounting(c.k.store, c.k.evm.publicClient as never);
      } finally {
        await c.k.stop();
      }
    },
  );

test(
  "Karaoke: a lost send stalls later nonces visibly until the chain consumes it; then the alarm reconciles it as superseded",
  { timeout: 180000 },
  async () => {
    const c = await karaoke("f4");
    const watch = rpcWatch();
    try {
      watch.on("eth_sendRawTransaction", () => {
        throw new TypeError("fixture send outage");
      });
      await publishV2(c.k.env, c.k.store, c.id);
      const own = txRow(c.k.store, intentOf(c.k.store, "record_result", c.ref)!.nonce!)!;
      assert.equal(own.broadcast, "attempted");
      await withdraw(c, "settings");
      // A payment behind it.
      enqueue(c.k.store, "close", "fixture-close", operator, "0x", 30000n);
      const close = (await dispatch(c.k.env, c.k.store, "close", "fixture-close"))!;
      const stalled = await warnings(async () => {
        await recover(c);
        await retry(c);
        await alarm(c as never);
      });
      const later = c.k.store
        .entries("tx:")
        .map(({ value }) => value as TxRow)
        .filter((row) => row.nonce > own.nonce);
      assert.ok(later.length >= 2 && later.every((row) => !row.mined), "every later nonce waits");
      assert.ok(later.some((row) => row.nonce === close.nonce));
      assert.ok(stalled.some((line) => line.includes("operator_nonce_withheld") && JSON.parse(line).nonce === own.nonce));
      assert.equal(txRow(c.k.store, own.nonce)!.mined, null);
      assert.equal(publicationV2(c.k.store, c.id)?.state, "pending");
      assert.equal(
        await c.k.evm.publicClient.getTransactionCount({ address: operator, blockTag: "latest" }),
        own.nonce,
      );
      // Another transaction at that nonce consumes it on chain.
      await consumeNonceExternally(c.k.evm, 31337, own.nonce);
      const external = watch.sent.length;
      // One read finding nothing is not enough; a read the depth later is.
      const first = await warnings(() => alarm(c as never));
      assert.ok(first.some((line) => line.includes("operator_nonce_unexplained")));
      assert.equal(txRow(c.k.store, own.nonce)!.mined, null);
      const reconciled = await warnings(() => alarm(c as never));
      assert.ok(reconciled.some((line) => line.includes("operator_nonce_superseded")));
      const row = txRow(c.k.store, own.nonce)!;
      assert.equal(row.mined?.status, "superseded");
      for (const field of ["raw", "hash", "data", "to", "kind", "ref"] as const)
        assert.equal(row[field], own[field]);
      await recover(c);
      await retry(c);
      assertPrivateState(c.k.store, c.id);
      assert.ok(!watch.sent.slice(external).includes(own.raw!));
      assert.equal(watch.sent.filter((raw) => raw === own.raw).length, 0);
      await nothingOnV3(c);
      await assertNonceAccounting(c.k.store, c.k.evm.publicClient as never);
    } finally {
      watch.restore();
      await c.k.stop();
    }
  },
);

test(
  "Karaoke: an older journal row that was never signed counts as never sent and is cancelled",
  { timeout: 180000 },
  async () => {
    const c = await karaoke("f5");
    const watch = rpcWatch();
    try {
      const allocated = (await injectFault("crash", c.k.env, c.k.store, c.ref, () =>
        publishV2(c.k.env, c.k.store, c.id),
      ))!;
      // As an older journal left it: allocated, never signed, no marker.
      const row = txRow(c.k.store, allocated.nonce)!;
      delete row.broadcast;
      delete row.raw;
      delete row.hash;
      c.k.store.set(`tx:${String(row.nonce).padStart(10, "0")}`, row);
      await revokeDirectly(c.k.evm as never, c.v4);
      await recover(c);
      await retry(c);
      const settled = txRow(c.k.store, allocated.nonce)!;
      assert.equal(settled.mined?.status, "cancelled");
      assert.equal(settled.raw, undefined);
      assert.ok(!watch.sent.includes(allocated.raw!));
      assert.equal(publicationV2(c.k.store, c.id)?.state, "private");
      await nothingOnV3(c);
      await assertNonceAccounting(c.k.store, c.k.evm.publicClient as never);
    } finally {
      watch.restore();
      await c.k.stop();
    }
  },
);

test("the operator's regular tick settles withheld result transactions", async () => {
  // services/karaoke.ts imports the Durable Object runtime, which node cannot
  // load; this checks the wiring the alarm relies on.
  const source = await readFile(new URL("../services/karaoke.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function tick("), source.indexOf("export async function recover("));
  assert.match(body, /await settleWithheldLearningTransactions\(env, store\);/);
  const runtime = await readFile(new URL("../services/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /async alarm\(\) \{\s*try \{ await tick\(this\.env, this\.store\); \}/);
  assert.match(runtime, /const unsettled = this\.store\.entries\("tx:"\)\.some\(\(\{ value \}\) => !\(value as \{ mined: unknown \}\)\.mined\);/);
});

test(
  "Karaoke: a mined original whose receipt read lags once is never settled superseded, and the result is reported published",
  { timeout: 180000 },
  async () => {
    const c = await karaoke("f6");
    const watch = rpcWatch();
    try {
      watch.on("eth_sendRawTransaction", () => {
        throw new TypeError("fixture send outage");
      });
      await publishV2(c.k.env, c.k.store, c.id);
      const own = txRow(c.k.store, intentOf(c.k.store, "record_result", c.ref)!.nonce!)!;
      assert.equal(own.broadcast, "attempted");
      await withdraw(c, "settings");
      await warnings(() => publishV2(c.k.env, c.k.store, c.id));
      assert.ok(txRow(c.k.store, own.nonce)!.withheld);
      // The earlier send reached a node after all: the original mines.
      await c.k.evm.rpc("eth_sendRawTransaction", [own.raw]);
      await c.k.evm.rpc("evm_mine", []);
      assert.notEqual(
        await c.k.evm.read(c.k.v3, "LearningResultsV3", "commitments", [c.session]),
        zeroHash,
      );
      // A lagging replica answers null once for its receipt and for the
      // transaction; the next read, the depth later, finds it.
      watch.on("eth_getTransactionReceipt", () => null, 1);
      watch.on("eth_getTransactionByHash", () => null, 1);
      await warnings(async () => {
        await alarm(c as never);
        await alarm(c as never);
      });
      assert.notEqual(txRow(c.k.store, own.nonce)!.mined?.status, "superseded");
      // The application reports what the chain holds.
      const external = watch.sent.length;
      for (let i = 0; i < 3; i++) await publishV2(c.k.env, c.k.store, c.id);
      await recover(c);
      assert.equal(publicationV2(c.k.store, c.id)?.state, "published");
      assert.equal(txRow(c.k.store, own.nonce)!.mined?.status, "success");
      assert.ok(!watch.sent.slice(external).includes(own.raw!));
      await assertNonceAccounting(c.k.store, c.k.evm.publicClient as never);
    } finally {
      watch.restore();
      await c.k.stop();
    }
  },
);

test(
  "Karaoke: a private result found on chain later is reported published, and a superseded row is corrected by its receipt",
  { timeout: 180000 },
  async () => {
    const c = await karaoke("f7");
    const watch = rpcWatch();
    try {
      watch.on("eth_sendRawTransaction", () => {
        throw new TypeError("fixture send outage");
      });
      await publishV2(c.k.env, c.k.store, c.id);
      const own = txRow(c.k.store, intentOf(c.k.store, "record_result", c.ref)!.nonce!)!;
      await withdraw(c, "settings");
      await warnings(() => publishV2(c.k.env, c.k.store, c.id));
      // The original mines, but every read of it answers null long enough
      // for the inference: the row is settled superseded.
      await c.k.evm.rpc("eth_sendRawTransaction", [own.raw]);
      await c.k.evm.rpc("evm_mine", []);
      watch.on("eth_getTransactionReceipt", () => null, 1000);
      watch.on("eth_getTransactionByHash", () => null, 1000);
      await warnings(async () => {
        await alarm(c as never);
        await alarm(c as never);
      });
      assert.equal(txRow(c.k.store, own.nonce)!.mined?.status, "superseded");
      watch.clear();
      // The view reads the commitment on V3 and reports it published; the
      // receipt corrects the row.
      const corrected = await warnings(() => publishV2(c.k.env, c.k.store, c.id));
      assert.equal(publicationV2(c.k.store, c.id)?.state, "published");
      assert.equal(txRow(c.k.store, own.nonce)!.mined?.status, "success");
      assert.ok(corrected.some((line) => line.includes("operator_nonce_superseded_corrected")));
    } finally {
      watch.restore();
      await c.k.stop();
    }
  },
);
