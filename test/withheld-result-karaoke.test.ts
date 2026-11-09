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
import { intentOf, txRow } from "../services/operator-tx.ts";
import { recoverLearningTransactions } from "../services/study-publication-recovery.ts";
import { learningBindingFixture } from "./learning-binding-fixture.ts";
import {
  assertNonceAccounting,
  assertWithheldJournal,
  faultName,
  faults,
  injectFault,
  revokeDirectly,
  revokeThroughOperator,
  rpcWatch,
  warnings,
  type Fault,
} from "./unsent-result-support.ts";

type Route = "settings" | "direct";
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
const recover = async (c: Karaoke) => {
  for (let i = 0; i < 3; i++) await recoverLearningTransactions(c.k.env, c.k.store);
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
            assert.deepEqual(publicationV2(c.k.store, c.id), {
              state: "private",
              revision: 1,
              reason: "authorization_withdrawn",
            });
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
      // The fee comes back within the limit; recovery then cancels the nonce.
      watch.clear();
      await recover(c);
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
