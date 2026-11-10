// Real local V3 contracts/D1; speech and source peers remain explicit simulations.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeEventLog, type TransactionReceipt } from "viem";
import { digest } from "../packages/protocol/index.ts";
import {
  resultsV3Abi,
  packStudyOutcomes,
  unpackStudyOutcomes,
} from "../packages/protocol/learning-results-v3.ts";
import {
  studyPublicationFixture,
  json,
  lessonPath,
} from "./study-publication-fixture.ts";
import {
  resumeStudyPublication,
  type PublicationJob,
} from "../services/study-publication.ts";
import {
  restoreStudyResult,
  projectStudyRevisions,
  type StudyRevisionEvidence,
} from "../services/study-revisions.ts";
import { intentOf, txRow } from "../services/operator-tx.ts";
import type { StudyPublicationReceipt } from "../packages/study/publication-view.ts";

test(
  "a held operator response cannot replace a newer D1 invalidation receipt",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixture(19900);
    const binding = f.env.KARAOKE_OPERATOR!;
    let release!: () => void,
      reached!: () => void,
      held = false;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let older: ReturnType<typeof refresh> | undefined;
    try {
      const lesson = await complete(f),
        id = lesson.lessonId;
      const job = f.store.get<PublicationJob>("studyPublication:" + id)!;
      const changed = packStudyOutcomes(
        unpackStudyOutcomes(job.outcomes, job.result.linesTotal).map((x) => ({
          ...x,
          status: "incorrect" as const,
        })),
      );
      const corrected = evidence(
        await f.evm.write(
          f.v3,
          "LearningResultsV3",
          "correct",
          [restoreStudyResult(job.result), job.outcomes, changed, 1],
          3,
        ),
      );
      const ledger = structuredClone(f.store.get("sponsor:ledger")),
        counts = f.counts();
      f.env.KARAOKE_OPERATOR = {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(input, init);
          const response = await binding.fetch(request);
          if (!held && new URL(request.url).pathname === "/study/terminal") {
            held = true;
            reached();
            await wait;
          }
          return response;
        },
      } as never;
      older = refresh(f, id);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          older.then(() => {
            throw Error("fixture_response_not_held");
          }),
          new Promise((_, reject) => {
            deadline = setTimeout(
              () => reject(Error("fixture_response_not_held")),
              15000,
            );
            deadline.unref();
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      const invalidated = evidence(
        await f.evm.write(
          f.v3,
          "LearningResultsV3",
          "invalidate",
          [corrected.result, corrected.outcomes, digest("fixture-d1-review")],
          3,
        ),
      );
      const newer = await refresh(f, id);
      assert.equal(
        newer.receipt.canonicalRevision?.commitment,
        invalidated.commitment,
      );
      release();
      assert.equal(
        (await older).receipt.canonicalRevision?.commitment,
        invalidated.commitment,
      );
      const saved = (await f.publication(id)).receipt!;
      assert.equal(saved.canonicalRevision?.status, 5);
      assert.equal(saved.commitment, job.receipt.commitment);
      assert.equal(saved.transactionHash, job.receipt.transactionHash);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.deepEqual(f.counts(), counts);
      const refused = await f.call(lessonPath(id) + "/publication", {
        method: "POST",
        headers: { cookie: f.auth.cookie },
      });
      assert.equal(refused.status, 403);
    } finally {
      release?.();
      await older?.catch(() => undefined);
      f.env.KARAOKE_OPERATOR = binding;
      await f.dispose();
    }
  },
);

function evidence(receipt: TransactionReceipt): StudyRevisionEvidence {
  for (const log of receipt.logs) {
    let e;
    try {
      e = decodeEventLog({
        abi: resultsV3Abi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
    } catch {
      continue;
    }
    if (e.eventName === "ResultPublished")
      return {
        result: e.args.result,
        outcomes: e.args.outcomes,
        commitment: e.args.commitment,
        transactionHash: receipt.transactionHash,
        blockNumber: String(receipt.blockNumber),
        blockHash: receipt.blockHash,
        logIndex: log.logIndex,
      };
  }
  throw Error("fixture_result_event_missing");
}
async function complete(
  f: Awaited<ReturnType<typeof studyPublicationFixture>>,
) {
  let lesson = await f.start();
  while (lesson.status === "active")
    lesson = (await f.answer(lesson, true)).lesson;
  return lesson;
}
async function refresh(
  f: Awaited<ReturnType<typeof studyPublicationFixture>>,
  id: string,
) {
  return json<{ state: string; receipt: StudyPublicationReceipt }>(
    await f.post(lessonPath(id) + "/publication", {}, f.auth),
  );
}

test(
  "canonical corrections, invalidation, restoration and a verified reorg preserve the original Study transaction",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixture(19898);
    try {
      const lesson = await complete(f),
        id = lesson.lessonId;
      const original = structuredClone(
        f.store.get<PublicationJob>("studyPublication:" + id)!,
      );
      const intent = structuredClone(
        intentOf(f.store, "record_result", "study:" + id + ":1")!,
      );
      const row = structuredClone(txRow(f.store, intent.nonce!)!);
      const ledger = structuredClone(f.store.get("sponsor:ledger")),
        calls = f.counts();
      const originalEvidence = evidence(
        await f.evm.publicClient.getTransactionReceipt({ hash: row.hash! }),
      );
      // No new grant can be used: the learner directly revokes the existing one.
      const nonce = await f.evm.read(f.v3, "LearningResultsV3", "nextNonce", [
        original.result.learner,
      ]);
      await f.evm.write(
        f.v3,
        "LearningResultsV3",
        "revoke",
        [original.result.learner, nonce, "0x"],
        5,
      );
      const changed = packStudyOutcomes(
        unpackStudyOutcomes(original.outcomes, original.result.linesTotal).map(
          (x) => ({ ...x, status: "incorrect" as const }),
        ),
      );
      const corrected = evidence(
        await f.evm.write(
          f.v3,
          "LearningResultsV3",
          "correct",
          [restoreStudyResult(original.result), original.outcomes, changed, 1],
          3,
        ),
      );
      const correctedView = await refresh(f, id);
      assert.equal(correctedView.receipt.canonicalRevision?.revision, 2);
      assert.equal(
        correctedView.receipt.canonicalRevision?.commitment,
        corrected.commitment,
      );
      assert.equal(
        correctedView.receipt.commitment,
        original.receipt.commitment,
      );
      assert.equal(correctedView.receipt.transactionHash, row.hash);
      const snapshot = await f.evm.rpc("evm_snapshot", []);
      const invalidated = evidence(
        await f.evm.write(
          f.v3,
          "LearningResultsV3",
          "invalidate",
          [corrected.result, corrected.outcomes, digest("fixture-review")],
          3,
        ),
      );
      assert.equal((await refresh(f, id)).receipt.canonicalRevision?.status, 5);
      await assert.rejects(
        f.evm.write(
          f.v3,
          "LearningResultsV3",
          "correct",
          [invalidated.result, invalidated.outcomes, original.outcomes, 1],
          2,
        ),
      );
      const restored = evidence(
        await f.evm.write(
          f.v3,
          "LearningResultsV3",
          "correct",
          [invalidated.result, invalidated.outcomes, original.outcomes, 1],
          3,
        ),
      );
      await f.evm.rpc("anvil_mine", ["0xc"]);
      const restoredView = await refresh(f, id);
      assert.equal(restoredView.receipt.canonicalRevision?.revision, 4);
      assert.equal(
        restoredView.receipt.canonicalRevision?.commitment,
        restored.commitment,
      );
      assert.equal(restoredView.receipt.confirmed, true);
      assert.equal(
        projectStudyRevisions(
          originalEvidence,
          [restored, corrected, invalidated],
          restored.commitment,
        ).latest.result.revision,
        4,
      );
      // A real reorg removes both newer revisions; lower revision 2 is canonical.
      assert.equal(await f.evm.rpc("evm_revert", [snapshot]), true);
      await f.evm.rpc("anvil_mine", ["0x10"]);
      const reorg = await refresh(f, id);
      assert.equal(reorg.receipt.canonicalRevision?.revision, 2);
      assert.equal(
        reorg.receipt.canonicalRevision?.commitment,
        corrected.commitment,
      );
      assert.equal(reorg.receipt.canonicalRevision?.status, 1);
      f.advance(3600001);
      await f.mineClock();
      const stale = await f.publication(id);
      assert.equal(stale.state, "pending");
      assert.equal(stale.receipt?.confirmed, false);
      assert.equal(stale.receipt?.reason, "canonical_audit_due");
      assert.deepEqual(f.counts(), calls);
      assert.equal((await refresh(f, id)).state, "published");
      const current = f.store.get<PublicationJob>("studyPublication:" + id)!;
      for (const key of [
        "requestHash",
        "target",
        "result",
        "outcomes",
        "data",
      ] as const)
        assert.deepEqual(current[key], original[key], key);
      assert.deepEqual(
        intentOf(f.store, "record_result", "study:" + id + ":1"),
        intent,
      );
      assert.deepEqual(txRow(f.store, intent.nonce!), row);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.deepEqual(f.counts(), calls);
      const [publicRead] = await f.readResults();
      assert.equal(publicRead.result.revision, 2);
      assert.equal(publicRead.commitment, corrected.commitment);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a held earlier canonical read cannot overwrite a newer invalidation or its proof",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixture(19899);
    const transport = globalThis.fetch;
    let release!: () => void, reached!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let held = false;
    try {
      const lesson = await complete(f),
        id = lesson.lessonId;
      const job = f.store.get<PublicationJob>("studyPublication:" + id)!;
      const changed = packStudyOutcomes(
        unpackStudyOutcomes(job.outcomes, job.result.linesTotal).map((x) => ({
          ...x,
          status: "incorrect" as const,
        })),
      );
      const corrected = evidence(
        await f.evm.write(
          f.v3,
          "LearningResultsV3",
          "correct",
          [restoreStudyResult(job.result), job.outcomes, changed, 1],
          3,
        ),
      );
      const ledger = structuredClone(f.store.get("sponsor:ledger")),
        counts = f.counts();
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url === f.evm.rpcUrl + "/" && request.method === "POST") {
          const body = (await request.clone().json()) as { method?: string };
          if (!held && body.method === "eth_getLogs") {
            held = true;
            const response = await transport(request);
            reached();
            await wait;
            return response;
          }
        }
        return transport(request);
      };
      const older = resumeStudyPublication(f.operatorEnv, f.store, id);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          older.then(() => {
            throw Error("fixture_hold_not_reached");
          }),
          new Promise((_, reject) => {
            deadline = setTimeout(
              () => reject(Error("fixture_hold_not_reached")),
              15000,
            );
            deadline.unref();
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      const invalidated = evidence(
        await f.evm.write(
          f.v3,
          "LearningResultsV3",
          "invalidate",
          [
            corrected.result,
            corrected.outcomes,
            digest("fixture-invalidation"),
          ],
          3,
        ),
      );
      const newer = await resumeStudyPublication(f.operatorEnv, f.store, id);
      assert.equal(newer.canonicalRevision?.commitment, invalidated.commitment);
      release();
      assert.equal(
        (await older).canonicalRevision?.commitment,
        invalidated.commitment,
      );
      assert.equal(
        f.store.get<StudyRevisionEvidence>("studyRevisionProof:" + id)
          ?.commitment,
        invalidated.commitment,
      );
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.deepEqual(f.counts(), counts);
    } finally {
      release?.();
      globalThis.fetch = transport;
      await f.dispose();
    }
  },
);
