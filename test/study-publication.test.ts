import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, zeroHash } from "viem";
import { accounts } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import { RECORDS_EPOCH_START } from "../packages/protocol/records.ts";
import {
  studyQualificationPolicy,
  qualifiesStudyResult,
} from "../packages/records/study-qualification.ts";
import {
  enrollmentRequest,
  acceptEnrollment,
} from "../services/learning-enrollment.ts";
import {
  enrollmentTypes,
  resultPeriod,
} from "../packages/protocol/learning-results-v3.ts";
import { studyPublicationFixture } from "./study-publication-fixture.ts";
import { communityScheduled } from "../services/community-application.ts";
import { intentOf, txRow } from "../services/operator-tx.ts";
import { publishManagedStudy } from "../services/study-operator-client.ts";
import {
  resultsV3Abi,
  unpackStudyOutcomes,
} from "../packages/protocol/learning-results-v3.ts";

test(
  "the actual application publishes a completed Study once and preserves first-pass misses through retries",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19871);
    try {
      let lesson = await f.start();
      lesson = (await f.answer(lesson, false)).lesson;
      while (lesson.status === "active")
        lesson = (await f.answer(lesson, true)).lesson;
      const published = await f.publication(lesson.lessonId);
      assert.equal(published.state, "published", JSON.stringify(published));
      const receipt = published.receipt!;
      assert.equal(receipt.confirmed, false);
      const intent = intentOf(
        f.store,
        "record_result",
        "study:" + lesson.lessonId + ":1",
      )!;
      const row = txRow(f.store, intent.nonce!)!;
      assert.equal(row.hash, receipt.transactionHash);
      assert.equal(row.to.toLowerCase(), f.v3.toLowerCase());
      const decoded = decodeFunctionData({ abi: resultsV3Abi, data: row.data });
      assert.equal(decoded.functionName, "publish");
      if (decoded.functionName !== "publish")
        throw Error("expected publication");
      const [result, outcomes] = decoded.args;
      assert.equal(result.activity, 2);
      assert.equal(result.qualificationPolicy, zeroHash);
      const parsed = unpackStudyOutcomes(outcomes, result.linesTotal);
      assert.equal(parsed.length, 10);
      assert.equal(parsed[0].status, "incorrect");
      assert.equal(
        parsed.filter((line) => line.status === "correct").length,
        9,
      );
      const evidence = await f.readResults();
      assert.equal(evidence.length, 1);
      assert.equal(
        evidence[0].verified,
        true,
        JSON.stringify(evidence[0].problems),
      );
      assert.equal(evidence[0].commitment, receipt.commitment);
      const before = f.store.entries("tx:"),
        ledger = f.store.get("sponsor:ledger");
      await Promise.all([
        f.get(lesson.lessonId),
        f.get(lesson.lessonId),
        publishManagedStudy(f.operator, await f.terminal(lesson.lessonId)),
      ]);
      assert.deepEqual(f.store.entries("tx:"), before);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.deepEqual(f.counts(), { calls: 11, observations: 11 });
      await f.evm.rpc("anvil_mine", ["0xc"]);
      await communityScheduled(f.env, f.ports);
      assert.equal(
        (await f.publication(lesson.lessonId)).receipt!.confirmed,
        true,
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "prospective Study qualification is independently readable and chain-time lag spends nothing",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19876);
    try {
      const policy = studyQualificationPolicy([accounts[2].address]);
      const nextPeriod =
        resultPeriod(BigInt(Math.floor(f.clock() / 1000))) + 1n;
      await f.evm.write(
        f.v3,
        "LearningResultsV3",
        "activatePolicy",
        [2, digest(policy), "ipfs://local-study-policy-fixture", nextPeriod],
        3,
      );
      const when =
        (BigInt(RECORDS_EPOCH_START) + nextPeriod * 86400n + 10n) * 1000n;
      f.advance(Number(when) - f.clock());
      await f.mineClock();
      const request = await enrollmentRequest(
        f.operatorEnv,
        accounts[5].address,
        f.store.now(),
      );
      const message = {
        ...request.message,
        activities: BigInt(request.message.activities),
        expiresAt: BigInt(request.message.expiresAt),
        nonce: BigInt(request.message.nonce),
      };
      const signature = await accounts[5].signTypedData({
        domain: request.domain,
        types: enrollmentTypes,
        primaryType: "Enrollment",
        message,
      });
      await acceptEnrollment(f.operatorEnv, f.store, message, signature);
      await f.mineClock();
      let lesson = await f.start();
      while (lesson.progress.firstPassGraded < 9)
        lesson = (await f.answer(lesson, true)).lesson;
      const ledger = f.store.get("sponsor:ledger");
      f.advance(5000); // Simulated app clock ahead of the pinned chain head.
      lesson = (await f.answer(lesson, true)).lesson;
      assert.equal(lesson.status, "completed");
      assert.equal((await f.publication(lesson.lessonId)).state, "pending");
      assert.equal(
        intentOf(f.store, "record_result", "study:" + lesson.lessonId + ":1"),
        undefined,
      );
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      await f.mineClock();
      await communityScheduled(f.env, f.ports);
      const published = await f.publication(lesson.lessonId);
      assert.equal(published.state, "published");
      const [read] = await f.readResults();
      assert.equal(read.verified, true, JSON.stringify(read.problems));
      assert.equal(read.result.qualificationPolicy, digest(policy));
      assert.equal(read.period, nextPeriod);
      assert.equal(
        qualifiesStudyResult(
          read,
          new Map([[digest(policy), policy]]),
          nextPeriod,
        ),
        true,
      );
      assert.equal(
        qualifiesStudyResult(
          read,
          new Map([[digest(policy), policy]]),
          nextPeriod - 1n,
        ),
        false,
      );
    } finally {
      await f.dispose();
    }
  },
);
