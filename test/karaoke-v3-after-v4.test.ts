// V3 Karaoke runs are unchanged when V4 becomes the operator's default for
// new work: a run in progress and a new V3-enrolled run both bind and publish
// to V3, and enrollment requests, grants and revocations stay on V3, until
// the learner withdraws under V4: their V3 results not yet sent then stay
// private. Explicit local contracts and an in-memory journal; no public
// network or provider.
import test from "node:test";
import assert from "node:assert/strict";
import { zeroHash, type Address } from "viem";
import { accounts } from "../harness/runtime.ts";
import { learningBindingFixture } from "./learning-binding-fixture.ts";
import {
  acceptEnrollment,
  activeEnrollment,
  enrollmentRequest,
  publicationV2,
  publishV2,
  revocationRequest,
  ticketAuthorization,
  type BoundEnrollment,
} from "../services/learning-results.ts";
import { intentOf } from "../services/operator-tx.ts";
import {
  acceptRevocationV4,
  revocationRequestV4,
} from "../services/learning-authorization.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { firstSong } from "../services/first-song-profile.ts";

test(
  "V3 Karaoke runs bind and publish to V3 after V4 becomes the default",
  { timeout: 120000 },
  async () => {
    const communityId = `0x${"5c".repeat(32)}` as const;
    const f = await learningBindingFixture(19992, communityId);
    try {
      f.env.RESULTS_V3_CONTRACT = f.v3;
      const learner = accounts[5]!.address as Address;
      const enrollment = await f.enrollment(3);
      let enrolled = await acceptEnrollment(
        f.env,
        f.store,
        enrollment.e,
        enrollment.signature,
      );
      for (let i = 0; !enrolled?.mined && i < 5; i++)
        enrolled = await acceptEnrollment(
          f.env,
          f.store,
          enrollment.e,
          enrollment.signature,
        );
      assert.equal(enrolled?.mined?.status, "success");
      const inProgress = await f.prepare("v3-run-before-v4");
      // Release: V4 is deployed and becomes the operator's default.
      const v4 = await f.evm.deploy("LearningResultsV4", [
        accounts[3].address,
        communityId,
        learningV4PublicityPolicy,
        firstSong.origin,
      ]);
      await f.evm.write(
        v4,
        "LearningResultsV4",
        "setGrader",
        [accounts[2].address, 1, true],
        3,
      );
      f.env.RESULTS_V4_CONTRACT = v4;
      // A new run without a sign-in authorization is a V3 run as before.
      const fresh = await f.prepare("v3-run-after-v4");
      for (const take of [inProgress, fresh]) {
        const id = take.ticket.ticketId;
        const bound = f.store.get<BoundEnrollment>(`enrollment:${id}`)!;
        assert.equal(bound.target?.version, 3);
        assert.equal(bound.target?.contract, f.v3.toLowerCase());
        assert.equal(ticketAuthorization(f.store, id), undefined);
        const result = await f.finish(take);
        for (
          let i = 0;
          i < 5 && publicationV2(f.store, id)?.state !== "published";
          i++
        )
          await publishV2(f.env, f.store, id);
        assert.equal(publicationV2(f.store, id)?.state, "published");
        assert.equal(
          intentOf(f.store, "record_result", `${id}:1`)?.to.toLowerCase(),
          f.v3.toLowerCase(),
        );
        assert.notEqual(
          await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
            result.attemptId,
          ]),
          zeroHash,
        );
        assert.equal(
          await f.evm.read(v4, "LearningResultsV4", "commitments", [
            result.attemptId,
          ]),
          zeroHash,
        );
      }
      // Enrollment work never moves onto V4, which has no enrollments. The
      // operator's Karaoke enrollment routes use this same default.
      assert.equal(
        (await enrollmentRequest(f.env, learner, f.store.now())).domain
          .version,
        "3",
      );
      assert.equal((await activeEnrollment(f.env, learner)).target?.version, 3);
      assert.equal(
        (await revocationRequest(f.env, learner)).domain.version,
        "3",
      );
    } finally {
      await f.stop();
    }
  },
);

test(
  "after the learner's V4 Revocation, V3 Karaoke results not yet sent stay private: a finished run and one in progress at the withdrawal",
  { timeout: 120000 },
  async () => {
    const communityId = `0x${"5d".repeat(32)}` as const;
    const f = await learningBindingFixture(19704, communityId);
    try {
      f.env.RESULTS_V3_CONTRACT = f.v3;
      const learner = accounts[5]!.address as Address;
      const enrollment = await f.enrollment(3);
      let enrolled = await acceptEnrollment(
        f.env,
        f.store,
        enrollment.e,
        enrollment.signature,
      );
      for (let i = 0; !enrolled?.mined && i < 5; i++)
        enrolled = await acceptEnrollment(
          f.env,
          f.store,
          enrollment.e,
          enrollment.signature,
        );
      assert.equal(enrolled?.mined?.status, "success");
      // A V3 run finishes; its result is final but not yet sent.
      const finished = await f.prepare("v3-run-finished-before-withdrawal");
      const first = await f.finish(finished);
      // Another V3 run is in progress when the learner withdraws.
      const open = await f.prepare("v3-run-open-at-withdrawal");
      // V4 becomes the records; the learner turns public results off.
      const v4 = await f.evm.deploy("LearningResultsV4", [
        accounts[3].address,
        communityId,
        learningV4PublicityPolicy,
        firstSong.origin,
      ]);
      await f.evm.write(
        v4,
        "LearningResultsV4",
        "setGrader",
        [accounts[2].address, 1, true],
        3,
      );
      f.env.RESULTS_V4_CONTRACT = v4;
      const request = await revocationRequestV4(f.env, learner);
      const signature = await accounts[5]!.signTypedData(request as never);
      let revoked = await acceptRevocationV4(
        f.env,
        f.store,
        learner,
        BigInt(request.message.nonce),
        signature,
      );
      for (let i = 0; !revoked?.mined && i < 5; i++)
        revoked = await acceptRevocationV4(
          f.env,
          f.store,
          learner,
          BigInt(request.message.nonce),
          signature,
        );
      assert.equal(revoked?.mined?.status, "success");
      // The V3 enrollment itself is still active on chain.
      assert.equal((await activeEnrollment(f.env, learner)).target?.version, 3);
      const second = await f.finish(open);
      for (const [take, result] of [
        [finished, first],
        [open, second],
      ] as const) {
        const id = take.ticket.ticketId;
        for (let i = 0; i < 3; i++) await publishV2(f.env, f.store, id);
        assert.deepEqual(publicationV2(f.store, id), {
          state: "private",
          revision: 1,
          reason: "authorization_withdrawn",
        });
        assert.equal(intentOf(f.store, "record_result", `${id}:1`), undefined);
        assert.equal(
          await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
            result.attemptId,
          ]),
          zeroHash,
        );
      }
    } finally {
      await f.stop();
    }
  },
);
