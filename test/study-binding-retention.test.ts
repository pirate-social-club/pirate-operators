import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { digest } from "../packages/protocol/index.ts";
import { STUDY_LESSON_NO_DEADLINE } from "../packages/study/lesson.ts";
import { studyExercisesHash } from "../packages/protocol/learning-results-v3.ts";
import type { StudyBinding } from "../services/study-operator.ts";
import type { Env } from "../services/runtime.ts";
import { Store } from "../services/operator-store.ts";
import {
  bindingEraseAfter,
  linkedBindingCleanupAlarm,
  sweepLinkedStudyBindings,
} from "../services/study-binding-retention.ts";
import {
  closedStudyPublication,
  closedStudyReceipt,
} from "../services/study-private-publication.ts";
import {
  reserveSponsorship,
  sponsorLimits,
} from "../services/sponsor-budget.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null,
    nested = 0;
  const sql = {
    exec(query: string, ...args: (string | number | null)[]) {
      const statement = db.prepare(query);
      const rows = statement.all(...args);
      return { toArray: () => rows };
    },
  };
  const transactionSync = <T>(fn: () => T): T => {
    const name = "test_" + nested++;
    db.exec("SAVEPOINT " + name);
    try {
      const result = fn();
      db.exec("RELEASE " + name);
      return result;
    } catch (error) {
      db.exec("ROLLBACK TO " + name);
      db.exec("RELEASE " + name);
      throw error;
    }
  };
  const storage = {
    sql,
    transactionSync,
    async transaction<T>(fn: () => T | Promise<T>) {
      const name = "test_" + nested++;
      db.exec("SAVEPOINT " + name);
      try {
        const result = await fn();
        db.exec("RELEASE " + name);
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO " + name);
        db.exec("RELEASE " + name);
        throw error;
      }
    },
    getAlarm: async () => alarm,
    setAlarm: async (due: number) => {
      alarm = due;
    },
  } as unknown as DurableObjectStorage;
  const store = new Store(storage);
  const env = {
    SPONSOR_CAP_WEI: "100000000000000",
    SPONSOR_GAS_PRICE_WEI: "1000",
    SPONSOR_GAS_LIMIT: "100000",
    SPONSOR_DATA_FEE_WEI: "100",
  } as Env;
  const target = {
    version: 4 as const,
    chainId: 31337 as const,
    contract: `0x${"c4".repeat(20)}` as const,
  };
  const authorizationId = `0x${"a1".repeat(32)}` as const;
  function binding(
    id = "fixture_linked_binding_0001",
    startedAt = 100123,
  ): StudyBinding {
    const offer = {
      lessonId: id,
      learner: `0x${"11".repeat(20)}` as const,
      sourceDigest: `0x${"22".repeat(32)}` as const,
      startedAt,
      expiresAt: STUDY_LESSON_NO_DEADLINE,
      authorizationId,
      speechChannel: "telegram-linked" as const,
      exercises: [1, 2, 3, 4].map((ordinal) => ({
        ordinal,
        lineId: `0x${ordinal.toString(16).padStart(64, "0")}` as const,
        language: "en",
      })),
    };
    return {
      offer,
      offerHash: digest(offer) as `0x${string}`,
      exercisesHash: studyExercisesHash([1, 2, 3, 4]),
      target,
      authorization: { id: authorizationId, issuedAt: 100, target },
    };
  }
  function insert(value = binding()) {
    store.set("studyBinding:" + value.offer.lessonId, value);
    for (const revision of [1, 2])
      reserveSponsorship(
        store,
        sponsorLimits(env),
        `record_result:study:${value.offer.lessonId}:${revision}`,
      );
    return value;
  }
  return {
    store,
    storage,
    env,
    binding,
    insert,
    dispose: () => db.close(),
    db,
  };
}
const absent = async () => true;

test("orphan linked binding erases only after the original 30+30 day bound and leaves a receipt-free replay marker", async () => {
  const f = fixture();
  try {
    const binding = f.insert(),
      id = binding.offer.lessonId,
      due = bindingEraseAfter(binding, id);
    f.store.set("clock", Math.floor(due / 1000));
    await sweepLinkedStudyBindings(f.env, f.store, 20, absent);
    assert.ok(f.store.get("studyBinding:" + id));
    f.store.set("clock", Math.ceil(due / 1000));
    await sweepLinkedStudyBindings(f.env, f.store, 20, absent);
    assert.equal(f.store.get("studyBinding:" + id), undefined);
    assert.deepEqual(closedStudyPublication(f.store, id), {
      kind: "binding",
      target: binding.target,
      reason: "private_history_expired",
    });
    assert.throws(
      () => closedStudyReceipt(f.store, id),
      /study_history_expired/,
    );
    assert.equal(f.store.get("studyPublication:" + id), undefined);
    for (const revision of [1, 2])
      assert.equal(
        f.store.get<{ state: string }>(
          `sponsor:reservation:record_result:study:${id}:${revision}`,
        )?.state,
        "released",
      );
    const snapshot = f.store.entries("sponsor:");
    await sweepLinkedStudyBindings(f.env, f.store, 20, absent);
    assert.deepEqual(f.store.entries("sponsor:"), snapshot);
    assert.equal(linkedBindingCleanupAlarm(f.store), Infinity);
    assert.doesNotMatch(
      JSON.stringify(closedStudyPublication(f.store, id)),
      /authorization|learner|exercises|receipt/,
    );
  } finally {
    f.dispose();
  }
});

test("native, unclassifiable, speech and concurrent publication evidence veto binding-only erasure", async () => {
  for (const kind of [
    "intent",
    "orphan-tx",
    "charged",
    "speech",
    "slot",
    "bad-tx",
    "proof-false",
    "concurrent-job",
  ] as const) {
    const f = fixture();
    try {
      const b = f.insert(),
        id = b.offer.lessonId;
      f.store.set("clock", Math.ceil(bindingEraseAfter(b, id) / 1000));
      const key =
        kind === "intent"
          ? `intent:record_result:study:${id}:1`
          : kind === "orphan-tx" || kind === "bad-tx"
            ? "tx:0000000001"
            : kind === "charged"
              ? `sponsor:reservation:record_result:study:${id}:3`
              : kind === "speech"
                ? "studySpeech:fixture_attempt_0001"
                : kind === "slot"
                  ? `studySpeechSlot:${id}:1:1`
                  : null;
      if (key)
        f.store.set(
          key,
          kind === "orphan-tx"
            ? {
                ref: `study:${id}:1`,
                kind: "record_result",
                raw: "0x01",
                hash: "0x02",
                broadcast: "unknown",
              }
            : kind === "bad-tx"
              ? { unknown: "missing reference" }
              : kind === "charged"
                ? { state: "charged", amount: "100" }
                : kind === "speech"
                  ? {
                      parameters: { lessonId: id },
                      receipt: { state: "uncertain" },
                    }
                  : kind === "slot"
                    ? "fixture_attempt_0001"
                    : { nonce: null },
        );
      const original = key ? f.store.get(key) : null;
      let proofs = 0;
      await sweepLinkedStudyBindings(f.env, f.store, 20, async () => {
        proofs++;
        if (kind === "concurrent-job")
          f.store.set("studyPublication:" + id, { state: "concurrent_record" });
        return kind !== "proof-false";
      });
      assert.ok(f.store.get("studyBinding:" + id), kind);
      assert.equal(closedStudyPublication(f.store, id), undefined, kind);
      if (key) assert.deepEqual(f.store.get(key), original, kind);
      if (key) assert.equal(proofs, 0, kind);
    } finally {
      f.dispose();
    }
  }
});

test("keyset cleanup advances across failing rows, restart and more than one batch without materializing prefixes", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 45; i++)
      f.store.set("studyBinding:a" + i.toString().padStart(3, "0"), {
        offer: { speechChannel: "telegram-linked" },
        target: { version: 4 },
      });
    const b = f.insert(f.binding("z_fixture_linked_binding_0001")),
      id = b.offer.lessonId;
    f.store.set("clock", Math.ceil(bindingEraseAfter(b, id) / 1000));
    // Prefix materialization is deliberately forbidden on this source path.
    f.store.entries = () => {
      throw Error("unbounded entries refused");
    };
    await sweepLinkedStudyBindings(f.env, f.store, 20, absent);
    assert.ok(f.store.get("studyBinding:" + id));
    const restarted = new Store(f.storage);
    restarted.entries = () => {
      throw Error("unbounded entries refused");
    };
    await sweepLinkedStudyBindings(f.env, restarted, 20, absent);
    await sweepLinkedStudyBindings(f.env, restarted, 20, absent);
    assert.equal(restarted.get("studyBinding:" + id), undefined);
    assert.equal(closedStudyPublication(restarted, id)?.kind, "binding");
  } finally {
    f.dispose();
  }
});

test("durable linked writes preserve earlier wakeups and roll back a failed operation", async () => {
  const f = fixture();
  try {
    await f.store.durableStudyWrite(() =>
      f.store.set("studyBinding:fixture", "fixture"),
    );
    const first = await f.storage.getAlarm();
    assert.ok(first && first > Date.now());
    await f.store.durableStudyWrite(() =>
      f.store.transaction(() => f.store.set("second", true)),
    );
    assert.equal(await f.storage.getAlarm(), first);
    await assert.rejects(
      f.store.durableStudyWrite(() => {
        f.store.set("rejected", true);
        throw Error("fixture rollback");
      }),
    );
    assert.equal(f.store.get("rejected"), undefined);
  } finally {
    f.dispose();
  }
});
