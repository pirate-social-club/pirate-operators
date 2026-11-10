import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { digest } from "../packages/protocol/index.ts";
import {
  resultsV3Abi,
  resultCommitment,
  type TerminalResult,
} from "../packages/protocol/learning-results-v3.ts";
import { studyResultFixture } from "./study-result-fixture.ts";
import {
  projectStudyRevisions,
  type StudyRevisionEvidence,
} from "../services/study-revisions.ts";
import {
  readStudyRevision,
  type StudyRevisionSearch,
} from "../services/study-revision-reader.ts";

const contract = `0x${"1".repeat(40)}` as const;
const hash = (n: number) => digest("fixture-block-" + n) as Hex;
function fixture(head = 200000) {
  const f = studyResultFixture(),
    event = resultsV3Abi.find(
      (e) => e.type === "event" && e.name === "ResultPublished",
    )!;
  const make = (
    result: TerminalResult,
    outcomes: Hex,
    block: number,
  ): StudyRevisionEvidence => ({
    result,
    outcomes,
    commitment: resultCommitment(result, outcomes),
    transactionHash: digest("fixture-tx-" + block),
    blockNumber: String(block),
    blockHash: hash(block),
    logIndex: 0,
  });
  const base = make(f.bundle.result, f.bundle.outcomes, 10);
  const second = make(
    { ...base.result, revision: 2, supersedes: base.commitment, status: 2 },
    base.outcomes,
    100,
  );
  const third = make(
    { ...second.result, revision: 3, supersedes: second.commitment, status: 5 },
    second.outcomes,
    110,
  );
  let events = [base, second],
    queries = 0;
  const orphaned = new Set<number>();
  const log = (e: StudyRevisionEvidence) => {
    const args = {
      sessionId: e.result.sessionId,
      learner: e.result.learner,
      revision: e.result.revision,
      result: e.result,
      outcomes: e.outcomes,
      commitment: e.commitment,
      publisher: e.result.grader,
    };
    return {
      address: contract,
      blockNumber: BigInt(e.blockNumber),
      blockHash: e.blockHash,
      transactionHash: e.transactionHash,
      logIndex: e.logIndex,
      removed: false,
      args,
      topics: encodeEventTopics({
        abi: resultsV3Abi,
        eventName: "ResultPublished",
        args,
      }),
      data: encodeAbiParameters(
        event.inputs.filter((x) => !("indexed" in x && x.indexed)),
        [e.result, e.outcomes, e.commitment, e.result.grader],
      ),
    };
  };
  const client = {
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return {
        number: blockNumber,
        hash: orphaned.has(Number(blockNumber))
          ? digest("orphaned-" + blockNumber)
          : hash(Number(blockNumber)),
      };
    },
    async getTransactionReceipt({ hash: transaction }: { hash: Hex }) {
      const e = [base, second, third].find(
        (e) => e.transactionHash === transaction,
      )!;
      return {
        status: "success",
        transactionHash: transaction,
        blockNumber: BigInt(e.blockNumber),
        blockHash: e.blockHash,
        logs: [log(e)],
      };
    },
    async getContractEvents({
      fromBlock,
      toBlock,
    }: {
      fromBlock: bigint;
      toBlock: bigint;
    }) {
      queries++;
      assert.ok(toBlock - fromBlock < 10000n);
      return events
        .filter(
          (e) =>
            BigInt(e.blockNumber) >= fromBlock &&
            BigInt(e.blockNumber) <= toBlock,
        )
        .map(log);
    },
  };
  return {
    base,
    second,
    third,
    make,
    orphaned,
    setEvents: (value: StudyRevisionEvidence[]) => {
      events = value;
    },
    queries: () => queries,
    input: {
      client: client as never,
      contract,
      head: { number: BigInt(head), hash: hash(head) },
      currentCommitment: second.commitment,
      originalHash: base.transactionHash,
      originalResult: base.result,
      originalOutcomes: base.outcomes,
    },
  };
}

test("indexed history older than one work budget resumes its exact durable range without claiming an older result", async () => {
  const f = fixture();
  let search: StudyRevisionSearch | undefined;
  for (let invocation = 0; invocation < 3; invocation++) {
    const before = f.queries();
    const read = await readStudyRevision({ ...f.input, search });
    assert.ok(f.queries() - before <= 8);
    if (invocation < 2) {
      assert.equal(read.complete, false);
      assert.equal(read.latest.commitment, f.base.commitment);
      assert.equal(read.search?.target, f.second.commitment);
      assert.equal(
        read.search?.nextToBlock,
        invocation === 0 ? "120000" : "40000",
      );
      search = JSON.parse(
        JSON.stringify(read.search, (_, value) =>
          typeof value === "bigint" ? String(value) : value,
        ),
      );
    } else {
      assert.equal(read.complete, true);
      assert.equal(read.latest.commitment, f.second.commitment);
      assert.equal(read.search, undefined);
    }
  }
  assert.equal(f.queries(), 20);
});

test("a missing public revision is never a favorable completed projection", async () => {
  const f = fixture(200);
  f.setEvents([f.base, f.third]);
  await assert.rejects(
    readStudyRevision({ ...f.input, currentCommitment: f.third.commitment }),
    /study_revision_history_incomplete/,
  );
  const partial = projectStudyRevisions(f.base, [f.third], f.third.commitment);
  assert.equal(partial.complete, false);
  assert.equal(partial.latest.commitment, f.base.commitment);
});

test("a verified orphaned anchor can downgrade while a merely behind head cannot", async () => {
  const f = fixture(200);
  f.orphaned.add(110);
  const down = await readStudyRevision({
    ...f.input,
    proof: f.third,
    currentCommitment: f.base.commitment,
  });
  assert.equal(down.complete, true);
  assert.equal(down.latest.result.revision, 1);
  await assert.rejects(
    readStudyRevision({
      ...f.input,
      head: { number: 50n, hash: hash(50) },
      proof: f.third,
      currentCommitment: f.base.commitment,
    }),
    /study_revision_head_behind/,
  );
});

test("changed context, wrong ancestry, invalid invalidation and mixed canonical heads are rejected", () => {
  const f = fixture();
  const changed = (patch: Partial<TerminalResult>, wire = f.second.outcomes) =>
    f.make({ ...f.second.result, ...patch }, wire, 100);
  assert.throws(
    () =>
      projectStudyRevisions(
        f.base,
        [changed({ completedAt: f.base.result.completedAt + 1n })],
        changed({ completedAt: f.base.result.completedAt + 1n }).commitment,
      ),
    /context_changed/,
  );
  const wrong = changed({ supersedes: digest("wrong-predecessor") });
  assert.throws(
    () => projectStudyRevisions(f.base, [wrong], wrong.commitment),
    /chain_changed/,
  );
  const invalid = changed({ status: 5 }, "0x000701000201000a01000401");
  assert.throws(
    () => projectStudyRevisions(f.base, [invalid], invalid.commitment),
    /invalidation|outcomes/,
  );
  assert.throws(
    () => projectStudyRevisions(f.base, [f.second], f.base.commitment),
    /head_conflict/,
  );
});

test("a changed canonical log block cannot become an accepted latest result", async () => {
  const f = fixture(200);
  f.orphaned.add(100);
  await assert.rejects(readStudyRevision(f.input), /log_not_canonical/);
});
