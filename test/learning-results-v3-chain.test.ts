import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, zeroHash, type Hex } from "viem";
import { chain } from "../harness/chain.ts";
import { accounts } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  enrollmentV3Id,
  enrollmentTypes,
  resultsV3Domain,
  resultCommitment,
  packStudyOutcomes,
  unpackStudyOutcomes,
} from "../packages/protocol/learning-results-v3.ts";
import { RECORDS_EPOCH_START } from "../packages/protocol/records.ts";
import { readPublicResultsV3 } from "../packages/records/results-v3.ts";
import { qualifiesStudyResult } from "../packages/records/study-qualification.ts";
import { completedStudyBundle } from "../packages/study/result-adapter.ts";
import { studyResultFixture } from "./study-result-fixture.ts";
import { stopChain } from "./payments-fixture.ts";

test(
  "actual V3 enrollment, terminal publication, correction and invalidation reconstruct independently",
  { timeout: 60000 },
  async () => {
    const evm = await chain(19745);
    try {
      const initial = studyResultFixture();
      const contract = await evm.deploy("LearningResultsV3", [
        accounts[3].address,
        initial.source.communityId,
        digest("publicity-v3"),
      ]);
      await evm.write(
        contract,
        "LearningResultsV3",
        "setGrader",
        [accounts[2].address, 2, true],
        3,
      );
      let now = (await evm.publicClient.getBlock()).timestamp;
      const nextPeriod = (now - BigInt(RECORDS_EPOCH_START)) / 86400n + 1n;
      await evm.write(
        contract,
        "LearningResultsV3",
        "activatePolicy",
        [2, digest(initial.policy), "ipfs://local-policy-fixture", nextPeriod],
        3,
      );
      const enrollment = {
        learner: accounts[5].address,
        communityId: initial.source.communityId,
        activities: 3n,
        publicityPolicy: digest("publicity-v3"),
        expiresAt: now + 3n * 86400n,
        nonce: 0n,
      };
      const signature = await accounts[5].signTypedData({
        domain: resultsV3Domain(31337, contract),
        types: enrollmentTypes,
        primaryType: "Enrollment",
        message: enrollment,
      });
      const id = enrollmentV3Id(31337, contract, enrollment);
      assert.equal(
        await evm.read(contract, "LearningResultsV3", "enrollmentDigest", [
          enrollment,
        ]),
        id,
      );
      await evm.write(
        contract,
        "LearningResultsV3",
        "enroll",
        [enrollment, signature],
        2,
      );
      const grant = (await evm.read(
        contract,
        "LearningResultsV3",
        "enrollments",
        [enrollment.learner],
      )) as readonly [Hex, bigint, bigint, bigint];
      now = BigInt(RECORDS_EPOCH_START) + nextPeriod * 86400n + 10n;
      await evm.rpc("evm_setNextBlockTimestamp", [Number(now)]);
      await evm.rpc("evm_mine", []);
      const f = studyResultFixture(undefined, Number(now) * 1000);
      const bundle = completedStudyBundle({
        ...f.input,
        enrollment: {
          id,
          issuedAt: Number(grant[2]),
          expiresAt: Number(grant[3]),
        },
      });
      await evm.rpc("evm_setNextBlockTimestamp", [
        Number(bundle.result.completedAt) + 1,
      ]);
      await evm.rpc("evm_mine", []);
      assert.equal(
        await evm.read(contract, "LearningResultsV3", "commitmentOf", [
          bundle.result,
          bundle.outcomes,
        ]),
        resultCommitment(bundle.result, bundle.outcomes),
      );
      await evm.write(
        contract,
        "LearningResultsV3",
        "publish",
        [bundle.result, bundle.outcomes],
        2,
      );
      await assert.rejects(() =>
        evm.write(
          contract,
          "LearningResultsV3",
          "publish",
          [bundle.result, bundle.outcomes],
          2,
        ),
      );
      const runtimeCodeHash = keccak256(
        (await evm.publicClient.getCode({ address: contract }))!,
      );
      const read = async (
        expectedCode = runtimeCodeHash,
        duringSource = async () => {},
        expectedToBlockHash?: Hex,
      ) =>
        readPublicResultsV3({
          rpcUrl: evm.rpcUrl,
          chainId: 31337,
          contract,
          runtimeCodeHash: expectedCode,
          communityId: f.source.communityId,
          fromBlock: 0n,
          toBlock: await evm.publicClient.getBlockNumber({ cacheTime: 0 }),
          expectedToBlockHash,
          studyManifest: async (hash) =>
            hash === digest(f.source) ? f.source : undefined,
          // Public-post authentication itself is qualified in the source-reader
          // test; this test isolates actual contract ABI/cryptography/readback.
          authenticateStudy: async (source) => {
            await duringSource();
            return digest(source) === digest(f.source);
          },
        });
      const policies = new Map([[digest(f.policy), f.policy]]);
      let results = await read();
      assert.equal(results.length, 1);
      assert(results[0].verified, JSON.stringify(results[0].problems));
      assert.equal(
        qualifiesStudyResult(results[0], policies, nextPeriod),
        true,
      );
      await assert.rejects(() => read(zeroHash), /result_code_changed/);
      const realCutoff = (await evm.publicClient.getBlock()).hash;
      assert.equal((await read(undefined, undefined, realCutoff)).length, 1);
      await assert.rejects(
        () =>
          read(
            undefined,
            undefined,
            digest("same height, different fork") as Hex,
          ),
        /canonical_head_changed_retry/,
      );
      const corrected = packStudyOutcomes(
        unpackStudyOutcomes(bundle.outcomes, 4).map((x) => ({
          ...x,
          status: "incorrect",
        })),
      );
      await evm.write(
        contract,
        "LearningResultsV3",
        "correct",
        [bundle.result, bundle.outcomes, corrected, 1],
        2,
      );
      results = await read();
      assert.equal(results.length, 1);
      assert(results[0].verified);
      assert.equal(results[0].result.revision, 2);
      assert.equal(results[0].result.completedAt, bundle.result.completedAt);
      assert.equal(results[0].period, nextPeriod);
      assert.equal(
        qualifiesStudyResult(results[0], policies, nextPeriod),
        false,
      );
      const beforeInvalidation = await evm.rpc("evm_snapshot", []);
      await evm.write(
        contract,
        "LearningResultsV3",
        "invalidate",
        [results[0].result, corrected, digest("test-invalidation")],
        3,
      );
      results = await read();
      assert.equal(results[0].result.revision, 3);
      assert.equal(results[0].verified, false);
      let changed = false;
      await assert.rejects(
        () =>
          read(runtimeCodeHash, async () => {
            if (changed) return;
            changed = true;
            assert.equal(
              await evm.rpc("evm_revert", [beforeInvalidation]),
              true,
            );
            await evm.rpc("evm_mine", []);
          }),
        /canonical_head_changed_retry/,
      );
    } finally {
      await stopChain(evm);
    }
  },
);
