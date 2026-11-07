// Regression of the independently demonstrated identical-receipt cursor race.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { digest } from "../packages/protocol/index.ts";
import {
  resultsV3Abi,
  resultCommitment,
} from "../packages/protocol/learning-results-v3.ts";
import { studyResultFixture } from "./study-result-fixture.ts";
import {
  saveReceipt,
  type PublicationJob,
} from "../services/study-publication.ts";
import type { ResultStore } from "../services/learning-transactions.ts";
import type { StudyRevisionSearch } from "../services/study-revision-reader.ts";

function fixture() {
  const { result, outcomes } = studyResultFixture().bundle;
  const id = "same-second-cursor-case",
    key = "studyPublication:" + id;
  const head = { number: "300000", hash: digest("head") };
  const job: PublicationJob = {
    requestHash: digest("request"),
    target: { chainId: 31337, version: 3, contract: `0x${"2".repeat(40)}` },
    result,
    outcomes,
    data: encodeFunctionData({
      abi: resultsV3Abi,
      functionName: "publish",
      args: [result, outcomes],
    }),
    lastTriedAt: 1000,
    privateHistoryExpiresAt: 3000000000000,
    receipt: {
      state: "pending",
      sessionId: result.sessionId,
      chainId: 31337,
      contract: `0x${"2".repeat(40)}`,
      commitment: resultCommitment(result, outcomes),
      transactionHash: digest("original-tx"),
      confirmed: false,
      checkedAt: 1000,
      canonicalHead: head,
      reason: "revision_history_pending",
    },
  };
  let entries = new Map<string, unknown>([
    [key, structuredClone(job)],
    [
      "native-intent",
      { nonce: 9, raw: "original-signed-bytes", reserved: "13" },
    ],
    ["provider-observation", { starts: 10 }],
  ]);
  let fail = false;
  const store: ResultStore = {
    get: <T>(key: string) => structuredClone(entries.get(key)) as T | undefined,
    set: (name, value) => {
      if (fail && name === key) throw Error("fixture-write-failed");
      entries.set(name, structuredClone(value));
    },
    delete: (name) => {
      entries.delete(name);
    },
    entries: (prefix) =>
      [...entries]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value: structuredClone(value) })),
    now: () => 1000,
    transaction: <T>(fn: () => T) => {
      const before = structuredClone(entries);
      try {
        return fn();
      } catch (error) {
        entries = before;
        throw error;
      }
    },
  };
  const search = (nextToBlock: string): StudyRevisionSearch => ({
    target: digest("new-canonical"),
    anchor: job.receipt.commitment,
    head,
    nextToBlock,
    events: [],
  });
  return {
    store,
    id,
    key,
    job,
    search,
    fail: () => {
      fail = true;
    },
  };
}

test("same-second identical pending receipts cannot roll durable progress backward", () => {
  const f = fixture(),
    older = f.store.get<PublicationJob>(f.key)!;
  const native = f.store.get("native-intent"),
    provider = f.store.get("provider-observation");
  saveReceipt(f.store, f.id, older, f.job.receipt, {
    search: f.search("140000"),
  });
  const newer = f.store.get<PublicationJob>(f.key)!;
  saveReceipt(f.store, f.id, newer, f.job.receipt, {
    search: f.search("60000"),
  });
  saveReceipt(f.store, f.id, older, f.job.receipt, {
    search: f.search("140000"),
  });
  assert.equal(
    f.store.get<StudyRevisionSearch>("studyRevisionSearch:" + f.id)
      ?.nextToBlock,
    "60000",
  );
  const saved = f.store.get<PublicationJob>(f.key)!;
  assert.equal(saved.observationRevision, 2);
  assert.deepEqual(saved.receipt, f.job.receipt);
  for (const key of [
    "requestHash",
    "target",
    "result",
    "outcomes",
    "data",
  ] as const)
    assert.deepEqual(saved[key], f.job[key]);
  assert.deepEqual(f.store.get("native-intent"), native);
  assert.deepEqual(f.store.get("provider-observation"), provider);
});

test("cursor and observation generation roll back together when the receipt write fails", () => {
  const f = fixture();
  saveReceipt(f.store, f.id, f.job, f.job.receipt, {
    search: f.search("140000"),
  });
  const before = f.store.get<PublicationJob>(f.key)!;
  f.fail();
  assert.throws(
    () =>
      saveReceipt(f.store, f.id, before, f.job.receipt, {
        search: f.search("60000"),
      }),
    /fixture-write-failed/,
  );
  assert.deepEqual(f.store.get<PublicationJob>(f.key), before);
  assert.equal(
    f.store.get<StudyRevisionSearch>("studyRevisionSearch:" + f.id)
      ?.nextToBlock,
    "140000",
  );
});
