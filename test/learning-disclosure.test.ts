import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToHex, zeroHash } from "viem";
import { accounts } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import { revocationTypes } from "../packages/protocol/learning-results.ts";
import { learningPolicyPage } from "../services/learning-policy-pages.ts";
import {
  learningV3Disclosure,
  learningV3PublicityPolicy,
} from "../services/learning-policy-v3.ts";
import {
  acceptEnrollment,
  acceptRevocation,
  activeEnrollment,
  enrollmentForPractice,
  enrollmentRequest,
  revocationRequest,
} from "../services/learning-enrollment.ts";
import { bindEnrollment } from "../services/learning-results.ts";
import { learningBindingFixture } from "./learning-binding-fixture.ts";
import {
  communityFetch,
  type CommunityEnv,
  type CommunityDependencies,
} from "../services/community-application.ts";
import { firstSong } from "../services/first-song-profile.ts";

test("versioned served documents bind the V3 contract and signature while V2 bytes stay pinned", async () => {
  const body = async (path: string) => {
    const response = await communityFetch(
      new Request(firstSong.origin + path),
      {} as CommunityEnv,
      {} as CommunityDependencies,
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    return response.text();
  };
  const v2 = `${await body("/terms")}\n\n${await body("/privacy")}`;
  assert.equal(
    keccak256(stringToHex(v2)),
    "0xed087bbce3b42c61236f9c26795f3b1b43e626ded9ac4a75bb97f43138791143",
  );
  const document = `${await body(learningV3Disclosure.termsUrl)}\n\n${await body(learningV3Disclosure.privacyUrl)}`;
  assert.equal(
    keccak256(stringToHex(document)),
    "0x9b68b19eb83315c5e26352717b6ceddf4e665d6773932e5a0ad6cbda495fa56c",
  );
  assert.equal(keccak256(stringToHex(document)), learningV3PublicityPolicy);
  assert.equal(learningPolicyPage("/learning/v3/unknown"), null);
  const f = await learningBindingFixture(19896);
  try {
    f.env.RESULTS_V3_CONTRACT = f.v3;
    const request = await enrollmentRequest(
      f.env,
      accounts[5].address,
      f.store.now(),
    );
    assert.deepEqual(request.disclosure, learningV3Disclosure);
    assert.equal(
      request.message.publicityPolicy,
      keccak256(stringToHex(document)),
    );
    assert.equal(
      await f.evm.read(f.v3, "LearningResultsV3", "publicityPolicy"),
      request.message.publicityPolicy,
    );
    const signed = await f.enrollment(3);
    const row = await acceptEnrollment(
      f.env,
      f.store,
      signed.e,
      signed.signature,
      signed.target,
    );
    assert.equal(row?.mined?.status, "success");
  } finally {
    await f.stop();
  }
});

test("an unknown V3 disclosure refuses fresh and already-enrolled practice before any intent, while revocation stays available", async () => {
  const f = await learningBindingFixture(
    19897,
    undefined,
    digest("unknown-publicity"),
  );
  try {
    f.env.RESULTS_V3_CONTRACT = f.v3;
    const signed = await f.enrollment(3);
    const before = f.store.entries("");
    await assert.rejects(
      enrollmentRequest(f.env, signed.e.learner, f.store.now()),
      /learning_disclosure_mismatch/,
    );
    await assert.rejects(
      acceptEnrollment(
        f.env,
        f.store,
        signed.e,
        signed.signature,
        signed.target,
      ),
      /learning_disclosure_mismatch/,
    );
    assert.deepEqual(f.store.entries(""), before);
    // An externally enrolled grant must not bypass the fresh-practice gate.
    await f.evm.write(
      f.v3,
      "LearningResultsV3",
      "enroll",
      [signed.e, signed.signature],
      2,
    );
    const grant = await activeEnrollment(
      f.env,
      signed.e.learner,
      signed.target,
      2,
    );
    assert.notEqual(grant.id, zeroHash);
    for (const activity of [1, 2] as const)
      await assert.rejects(
        enrollmentForPractice(
          f.env,
          f.store,
          signed.e.learner,
          signed.target,
          activity,
        ),
        /learning_disclosure_mismatch/,
      );
    await assert.rejects(
      bindEnrollment(f.env, f.store, digest("blocked-take"), signed.e.learner),
      /learning_disclosure_mismatch/,
    );
    assert.deepEqual(f.store.entries(""), before);
    const request = await revocationRequest(
      f.env,
      signed.e.learner,
      signed.target,
    );
    const nonce = BigInt(request.message.nonce);
    const signature = await accounts[5].signTypedData({
      domain: request.domain,
      types: revocationTypes,
      primaryType: "Revocation",
      message: { learner: signed.e.learner, nonce },
    });
    const revoked = await acceptRevocation(
      f.env,
      f.store,
      signed.e.learner,
      nonce,
      signature,
      signed.target,
    );
    assert.equal(revoked?.mined?.status, "success");
    const [id] = (await f.evm.read(f.v3, "LearningResultsV3", "enrollments", [
      signed.e.learner,
    ])) as readonly [string, ...unknown[]];
    assert.equal(id, zeroHash);
  } finally {
    await f.stop();
  }
});
