// A V3 Study result held at the operator whose dispatch failed before it was
// sent stays private after the learner withdraws under V4, by settings or by
// their own `revoke` call, whether the next attempt is the publication retry
// or background recovery. A transaction never allocated is withdrawn and
// refunded; one allocated but provably never sent is replaced at its nonce by
// a recorded cancellation. A transaction that may already have been sent is
// never sent again after the withdrawal is observed; only its receipt is
// reconciled. Actual community routes, D1, operator and local contracts; the
// posts RPC, IPFS transport and speech provider are the fixture's simulations.
import test from "node:test";
import assert from "node:assert/strict";
import { zeroHash, type Hex } from "viem";
import { accounts } from "../harness/runtime.ts";
import type { StudyLesson } from "../packages/study/lesson.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  acceptRevocationV4,
  revocationRequestV4,
} from "../services/learning-authorization.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  dispatch,
  enqueue,
  intentOf,
  txRow,
  type TxRow,
} from "../services/operator-tx.ts";
import {
  resumeStudyPublication,
  type PublicationJob,
} from "../services/study-publication.ts";
import {
  recoverLearningTransactions,
  settleWithheldLearningTransactions,
} from "../services/study-publication-recovery.ts";
import { closedStudyPublication } from "../services/study-private-publication.ts";
import {
  json,
  lessonPath,
  studyPublicationFixture,
} from "./study-publication-fixture.ts";
import {
  assertNonceAccounting,
  assertWithheldJournal,
  faultName,
  faults,
  injectFault,
  interceptOnce,
  consumeNonceExternally,
  unsentRow,
  operator,
  learnerIndex,
  revokeDirectly,
  revokeThroughOperator,
  rpcWatch,
  warnings,
  type Fault,
} from "./unsent-result-support.ts";

type Route = "settings" | "direct";
type Fixture = Awaited<ReturnType<typeof studyPublicationFixture>>;
type Auth = Record<string, string>;
let port = 19760;

/** A completed V3 lesson held at the operator, then V4 becomes the records. */
async function study() {
  const f = await studyPublicationFixture(port++);
  try {
    f.advance(3600_000);
    let lesson = await f.start();
    lesson = (await f.answer(lesson, false)).lesson;
    while (lesson.status === "active") lesson = (await f.answer(lesson, true)).lesson;
    assert.equal(lesson.status, "completed");
    const id = lesson.lessonId;
    const job = f.store.get<PublicationJob>(`studyPublication:${id}`)!;
    assert.equal(job.target.version, 3);
    assert.equal(job.receipt.state, "pending");
    assert.equal(intentOf(f.store, "record_result", `study:${id}:1`), undefined);
    const v4 = await f.evm.deploy("LearningResultsV4", [
      accounts[3].address,
      f.config.communityId,
      learningV4PublicityPolicy,
      firstSong.origin,
    ]);
    await f.evm.write(v4, "LearningResultsV4", "setGrader", [accounts[2].address, 2, true], 3);
    await f.applyV4Migration();
    f.operatorEnv.RESULTS_V4_CONTRACT = v4;
    (f.env as { STUDY_RESULTS_V4_CONTRACT?: string }).STUDY_RESULTS_V4_CONTRACT = v4;
    (f.config as { learningRecords: string }).learningRecords = v4.toLowerCase();
    await f.mineClock();
    return { f, v4, id, ref: `study:${id}:1`, session: job.result.sessionId as Hex };
  } catch (error) {
    await f.dispose();
    throw error;
  }
}
type Study = Awaited<ReturnType<typeof study>>;
const withdraw = (c: Study, route: Route) =>
  route === "settings"
    ? revokeThroughOperator(c.f.operatorEnv, c.f.store, acceptRevocationV4, revocationRequestV4)
    : revokeDirectly(c.f.evm as never, c.v4);
const resume = (c: Study) => resumeStudyPublication(c.f.operatorEnv, c.f.store, c.id);
const retry = async (c: Study) => {
  for (let i = 0; i < 3; i++) await resume(c);
};
const recover = async (c: Study) => {
  for (let i = 0; i < 3; i++) await recoverLearningTransactions(c.f.operatorEnv, c.f.store);
};
async function publication(c: Study, auth: Auth = c.f.auth) {
  return json<{
    state: string;
    receipt: {
      state: string;
      reason?: string;
      neverSubmitted?: boolean;
      transactionHash: Hex | null;
    } | null;
  }>(await c.f.post(lessonPath(c.id) + "/publication", {}, auth));
}
async function assertPrivate(c: Study) {
  const view = await publication(c);
  assert.equal(view.state, "private");
  assert.equal(view.receipt!.reason, "authorization_withdrawn");
  assert.equal(view.receipt!.neverSubmitted, true);
  assert.equal(view.receipt!.transactionHash, null);
}
async function nothingOnV3(c: Study) {
  assert.equal(
    await c.f.evm.read(c.f.v3, "LearningResultsV3", "commitments", [c.session]),
    zeroHash,
  );
}

for (const fault of faults)
  for (const route of ["settings", "direct"] as Route[])
    for (const first of ["retry", "recovery"] as const)
      test(
        `Study: after ${faultName[fault]}, a ${route} withdrawal keeps the held V3 result unpublished, with ${first} first`,
        { timeout: 300000 },
        async () => {
          const c = await study();
          const watch = rpcWatch();
          try {
            const allocated = await injectFault(fault as Fault, c.f.operatorEnv, c.f.store, c.ref, () =>
              resume(c),
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
            await assertPrivate(c);
            await nothingOnV3(c);
            await assertWithheldJournal(c.f.store, c.f.evm.publicClient as never, c.ref, allocated, watch.sent);
            await assertNonceAccounting(c.f.store, c.f.evm.publicClient as never);
          } finally {
            watch.restore();
            await c.f.dispose();
          }
        },
      );

/** A V4 lesson; its first start relays the learner's sign-in. */
async function startV4(f: Fixture, auth: Auth) {
  for (let i = 0; i < 5; i++) {
    const response = await f.post(
      "/api/study/lessons",
      { requestId: crypto.randomUUID(), song: f.song },
      auth,
    );
    if (response.status === 200) return (await response.json()) as StudyLesson;
    await f.recordSignIns();
  }
  throw Error("V4 lesson did not start");
}

test(
  "Study: turning public results off in settings after a crash before broadcast cancels the held V3 result's nonce",
  { timeout: 300000 },
  async () => {
    const c = await study();
    const watch = rpcWatch();
    try {
      const auth = await c.f.login();
      await c.f.mineClock();
      await startV4(c.f, auth);
      const allocated = await injectFault("crash", c.f.operatorEnv, c.f.store, c.ref, () => resume(c));
      const request = await json<{ message: { learner: string; nonce: string } }>(
        await c.f.post("/api/learning/public-results/off", {}, auth),
      );
      const signature = await accounts[learnerIndex].signTypedData(request as never);
      const off = await json<{ state: string; publicResults: string }>(
        await c.f.post(
          "/api/learning/public-results/off",
          { message: request.message, signature },
          auth,
        ),
      );
      assert.equal(off.publicResults, "off");
      await recover(c);
      await retry(c);
      await recover(c);
      await assertPrivate(c);
      await nothingOnV3(c);
      await assertWithheldJournal(c.f.store, c.f.evm.publicClient as never, c.ref, allocated, watch.sent);
    } finally {
      watch.restore();
      await c.f.dispose();
    }
  },
);

test(
  "Study: a withdrawal accepted while the dispatch waits for its fee read stops the allocation",
  { timeout: 300000 },
  async () => {
    const c = await study();
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
    try {
      try {
        await resume(c);
      } finally {
        globalThis.fetch = realFetch;
      }
      assert.equal(fired, true);
      assert.equal(intentOf(c.f.store, "record_result", c.ref)?.nonce, null);
      await retry(c);
      await recover(c);
      await assertPrivate(c);
      assert.equal(intentOf(c.f.store, "record_result", c.ref), undefined);
      await nothingOnV3(c);
      await assertNonceAccounting(c.f.store, c.f.evm.publicClient as never);
    } finally {
      await c.f.dispose();
    }
  },
);

test(
  "Study: when the fee limits refuse the cancellation, nothing is sent and it waits",
  { timeout: 300000 },
  async () => {
    const c = await study();
    const watch = rpcWatch();
    try {
      const allocated = (await injectFault("crash", c.f.operatorEnv, c.f.store, c.ref, () => resume(c)))!;
      await revokeDirectly(c.f.evm as never, c.v4);
      const above = "0x" + (BigInt(c.f.operatorEnv.SPONSOR_GAS_PRICE_WEI!) * 10n).toString(16);
      watch.on("eth_gasPrice", () => above, 1000);
      const before = watch.sent.length;
      const logged = await warnings(async () => {
        await assert.rejects(resume(c), /gas_price_above_limit/);
        await recover(c);
        await retry(c);
      });
      assert.equal(watch.sent.length, before, "nothing was sent");
      const row = txRow(c.f.store, allocated.nonce)!;
      assert.equal(row.withheld?.reason, "authorization_withdrawn");
      assert.equal(row.cancellation, undefined);
      assert.equal(row.mined, null);
      assert.ok(logged.some((line) => line.includes("operator_cancellation_waiting")));
      // Proven never sent, it can never publish, even while the nonce waits.
      await assertPrivate(c);
      // The fee comes back within the limit; the alarm's settlement, not
      // only /recover, then cancels the nonce.
      watch.clear();
      await settleWithheldLearningTransactions(c.f.operatorEnv, c.f.store);
      await nothingOnV3(c);
      await assertWithheldJournal(c.f.store, c.f.evm.publicClient as never, c.ref, allocated, watch.sent);
    } finally {
      watch.restore();
      await c.f.dispose();
    }
  },
);

for (const origin of ["historical", "attempted"] as const)
  test(
    origin === "historical"
      ? "Study: a journal row from before the broadcast marker is treated as possibly sent: never cancelled, never resent, its receipt reconciled"
      : "Study: a row whose send was attempted is never resent after the withdrawal; only its receipt is reconciled",
    { timeout: 300000 },
    async () => {
      const c = await study();
      const watch = rpcWatch();
      try {
        let original: Hex;
        let nonce: number;
        if (origin === "historical") {
          const allocated = (await injectFault("crash", c.f.operatorEnv, c.f.store, c.ref, () => resume(c)))!;
          // As the journal held it before this change: no broadcast field.
          const row = txRow(c.f.store, allocated.nonce)!;
          delete row.broadcast;
          c.f.store.set(`tx:${String(row.nonce).padStart(10, "0")}`, row);
          original = row.raw!;
          nonce = row.nonce;
        } else {
          // The send is attempted; the node never answers, so its fate is unknown.
          watch.on("eth_sendRawTransaction", () => {
            throw new TypeError("fixture send outage");
          });
          await resume(c);
          const row = txRow(c.f.store, intentOf(c.f.store, "record_result", c.ref)!.nonce!)!;
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
        assert.ok(!watch.sent.slice(sentBefore).includes(original));
        const row = txRow(c.f.store, nonce)!;
        assert.equal(row.withheld?.reason, "authorization_withdrawn");
        assert.equal(row.cancellation, undefined);
        assert.equal(row.mined, null);
        assert.equal((await publication(c)).state, "pending");
        const stuck = logged.find((line) => line.includes("operator_nonce_withheld"));
        assert.ok(stuck);
        assert.equal(JSON.parse(stuck).nonce, nonce);
        assert.ok(
          c.f.store
            .entries("tx:")
            .some(({ value }) => (value as { nonce: number }).nonce > nonce && !(value as { mined: unknown }).mined),
        );
        await nothingOnV3(c);
        // The earlier send reaches the chain after all: the receipt is
        // reconciled and the result is published, as it was sent before the
        // withdrawal.
        await c.f.evm.rpc("eth_sendRawTransaction", [original]);
        await c.f.evm.rpc("evm_mine", []);
        const external = watch.sent.length;
        await recover(c);
        await retry(c);
        assert.equal(txRow(c.f.store, nonce)!.mined?.status, "success");
        assert.equal((await publication(c)).state, "published");
        assert.ok(!watch.sent.slice(external).includes(original));
        await assertNonceAccounting(c.f.store, c.f.evm.publicClient as never);
      } finally {
        watch.restore();
        await c.f.dispose();
      }
    },
  );

for (const [route, at] of [
  ["settings", "receipt"],
  ["direct", "receipt"],
  ["settings", "revokedAt"],
] as const)
  test(
    `Study: a ${route} withdrawal during the pre-send ${at} read keeps the original bytes from being sent`,
    { timeout: 300000 },
    async () => {
      const c = await study();
      let snapshot: ReturnType<typeof unsentRow>;
      // The settings Revocation is relayed behind the result's unsent nonce,
      // so the chain shows no withdrawal; only the operator's record does.
      const hook = interceptOnce(
        at,
        async () => {
          snapshot = structuredClone(unsentRow(c.f.store, c.ref));
          await withdraw(c, route);
        },
        () => !!unsentRow(c.f.store, c.ref),
      );
      const watch = rpcWatch();
      try {
        try {
          await resume(c);
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
        await assertPrivate(c);
        await nothingOnV3(c);
        await assertWithheldJournal(c.f.store, c.f.evm.publicClient as never, c.ref, snapshot!, [...watch.sent, ...all.sent]);
        await assertNonceAccounting(c.f.store, c.f.evm.publicClient as never);
      } finally {
        await c.f.dispose();
      }
    },
  );

test(
  "Study: a lost send stalls later nonces visibly until the chain consumes it; then the alarm reconciles it as superseded",
  { timeout: 300000 },
  async () => {
    const c = await study();
    const watch = rpcWatch();
    try {
      watch.on("eth_sendRawTransaction", () => {
        throw new TypeError("fixture send outage");
      });
      await resume(c);
      const own = txRow(c.f.store, intentOf(c.f.store, "record_result", c.ref)!.nonce!)!;
      assert.equal(own.broadcast, "attempted");
      await withdraw(c, "settings");
      enqueue(c.f.store, "close", "fixture-close", operator, "0x", 30000n);
      const close = (await dispatch(c.f.operatorEnv, c.f.store, "close", "fixture-close"))!;
      const stalled = await warnings(async () => {
        await recover(c);
        await retry(c);
        await settleWithheldLearningTransactions(c.f.operatorEnv, c.f.store);
      });
      const later = c.f.store
        .entries("tx:")
        .map(({ value }) => value as TxRow)
        .filter((row) => row.nonce > own.nonce);
      assert.ok(later.length >= 2 && later.every((row) => !row.mined), "every later nonce waits");
      assert.ok(later.some((row) => row.nonce === close.nonce));
      assert.ok(stalled.some((line) => line.includes("operator_nonce_withheld") && JSON.parse(line).nonce === own.nonce));
      assert.equal((await publication(c)).state, "pending");
      await consumeNonceExternally(c.f.evm, 31337, own.nonce);
      const reconciled = await warnings(() =>
        settleWithheldLearningTransactions(c.f.operatorEnv, c.f.store),
      );
      assert.ok(reconciled.some((line) => line.includes("operator_nonce_superseded")));
      const row = txRow(c.f.store, own.nonce)!;
      assert.equal(row.mined?.status, "superseded");
      for (const field of ["raw", "hash", "data", "to", "kind", "ref"] as const)
        assert.equal(row[field], own[field]);
      await recover(c);
      await retry(c);
      const view = await publication(c);
      assert.equal(view.state, "private");
      assert.equal(view.receipt!.reason, "authorization_withdrawn");
      // It may have been sent before the withdrawal, so it is not marked
      // never submitted; its nonce went to another transaction.
      assert.notEqual(view.receipt!.neverSubmitted, true);
      assert.equal(watch.sent.filter((raw) => raw === own.raw).length, 0);
      await nothingOnV3(c);
      await assertNonceAccounting(c.f.store, c.f.evm.publicClient as never);
    } finally {
      watch.restore();
      await c.f.dispose();
    }
  },
);

test(
  "Study: private history is not erased while the cancellation of its withheld transaction is unmined",
  { timeout: 300000 },
  async () => {
    const c = await study();
    const watch = rpcWatch();
    try {
      const allocated = (await injectFault("crash", c.f.operatorEnv, c.f.store, c.ref, () => resume(c)))!;
      await revokeDirectly(c.f.evm as never, c.v4);
      // The cancellation is sent, but that send is lost.
      watch.on("eth_sendRawTransaction", () => {
        throw new TypeError("fixture send outage");
      });
      await resume(c);
      await assertPrivate(c);
      const row = txRow(c.f.store, allocated.nonce)!;
      assert.ok(row.cancellation?.hash);
      assert.equal(row.mined, null);
      const job = c.f.store.get<PublicationJob>(`studyPublication:${c.id}`)!;
      c.f.advance(job.privateHistoryExpiresAt + 1000 - c.f.clock());
      await resume(c);
      assert.ok(c.f.store.get(`studyPublication:${c.id}`), "kept while the nonce is open");
      assert.equal(closedStudyPublication(c.f.store, c.id), undefined);
      // The alarm resends the cancellation; once mined, erasure proceeds.
      await settleWithheldLearningTransactions(c.f.operatorEnv, c.f.store);
      assert.equal(txRow(c.f.store, allocated.nonce)!.mined?.status, "cancelled");
      await resume(c);
      assert.equal(c.f.store.get(`studyPublication:${c.id}`), undefined);
      assert.equal(closedStudyPublication(c.f.store, c.id)!.receipt.privateHistoryErased, true);
      assert.ok(txRow(c.f.store, allocated.nonce), "the row stays for nonce accounting");
      await nothingOnV3(c);
    } finally {
      watch.restore();
      await c.f.dispose();
    }
  },
);
