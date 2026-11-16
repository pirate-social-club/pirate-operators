import { prepareInitialLearningV5 } from "../services/learning-v5-publication.ts";
import type { BoundPublicationGrantV1 } from "../packages/protocol/publication-runtime-v1.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  parsePublicationGrant,
  parsePublicationCorrection,
  preparePublicationGrant,
  preparePublicationWithdrawal,
  publicationCorrectionDigest,
  publicationDomain,
  publicationPolicy,
  verifyPublicationPolicy,
} from "../packages/protocol/publication-consent.ts";
import { publicationConsentAbi } from "../packages/protocol/generated/publication-consent-v1.ts";
import { learningResultsV5Abi } from "../packages/protocol/generated/learning-results-v5.ts";
import {
  learningCommitmentV5,
  readLearningPublicationV5,
  type LearningResultV5,
} from "../packages/protocol/learning-results-v5.ts";
import {
  danceCaptureHash,
  danceSourceHash,
  danceCommand,
  dancePolicyHash,
  type DancePolicy,
} from "../packages/dance-chain/v2/wire.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/v2/abi.ts";

const digest = (char: string): Hex => `0x${char.repeat(64)}`;
const learner: Address = "0x1111111111111111111111111111111111111111";
const registry: Address = "0x2222222222222222222222222222222222222222";
const publisherB: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const grant = {
  learner,
  communityId: digest("3"),
  purpose: "karaoke-results",
  publicationTarget: registry,
  publicationTargetRuntimeHash: digest("4"),
  permissionRevision: "1",
  policyHash: digest("5"),
  withdrawalEpoch: "0",
  nonce: digest("6"),
  issuedAt: "1800000000",
  validAfter: "1800000000",
  expiresAt: "1800003600",
  submitBefore: "1800000600",
};
const withdrawal = {
  learner,
  communityId: grant.communityId,
  purpose: grant.purpose,
  expectedEpoch: "0",
  nonce: grant.nonce,
  submitBefore: grant.submitBefore,
};
const correction = {
  learner,
  communityId: grant.communityId,
  purpose: grant.purpose,
  publicationTarget: registry,
  publicationTargetRuntimeHash: grant.publicationTargetRuntimeHash,
  permissionRevision: "1",
  policyHash: grant.policyHash,
  withdrawalEpoch: "1",
  resultId: digest("7"),
  originalGrantId: digest("8"),
  previousCommitment: digest("9"),
  correctedCommitment: digest("a"),
  reasonHash: digest("0"),
  nonce: digest("6"),
  issuedAt: grant.issuedAt,
  submitBefore: grant.submitBefore,
};

test("three EIP-712 vectors match independent Solidity typed-word assertions", () => {
  assert.equal(
    preparePublicationGrant(31337n, registry, grant, "0x").digest,
    "0x1ce5f32e2f8d407fb29a2bcfad26b7aacedacdbe9eabb15a6b2faddc3b46368d",
  );
  assert.equal(
    preparePublicationWithdrawal(31337n, registry, withdrawal, "0x").digest,
    "0x5a960761f5bb48d04b38af3b3b74fb497c5e5d07360c434d027f04a95df68b6d",
  );
  assert.equal(
    publicationCorrectionDigest(31337n, registry, correction),
    "0x0f7b6ce0a7e8bd00c2280dc34699c86e5951460aaf6c1fc4ac1d4590a4ef0ccf",
  );
});
test("actual typed signature and generated call bind recipient, chain, target and purpose", async () => {
  const account = privateKeyToAccount(`0x${"0".repeat(60)}123a`);
  const input = { ...grant, learner: account.address.toLowerCase() };
  const prepared = preparePublicationGrant(31337n, registry, input, "0x");
  const signature = await account.signTypedData(prepared.typed);
  assert.equal(
    await verifyTypedData({
      ...prepared.typed,
      address: account.address,
      signature,
    }),
    true,
  );
  for (const typed of [
    { ...prepared.typed, domain: publicationDomain(6343n, registry) },
    { ...prepared.typed, domain: publicationDomain(31337n, learner) },
    {
      ...prepared.typed,
      message: { ...prepared.message, purpose: "study-results" },
    },
  ])
    assert.equal(
      await verifyTypedData({ ...typed, address: account.address, signature }),
      false,
    );
  const sent = preparePublicationGrant(31337n, registry, input, signature);
  const decoded = decodeFunctionData({
    abi: publicationConsentAbi,
    data: sent.data,
  });
  assert.equal(decoded.functionName, "grant");
  assert.deepEqual(decoded.args, [
    { ...sent.message, learner: account.address },
    signature,
  ]);
  input.nonce = digest("a");
  assert.equal(sent.message.nonce, grant.nonce);
  assert.throws(() => {
    Object.assign(sent.message, { nonce: digest("a") });
  });
});
test("closed transport rejects old envelopes, extra keys and every line terminator", () => {
  assert.throws(() =>
    parsePublicationGrant({ ...grant, origin: "https://old.example" }),
  );
  assert.throws(() =>
    parsePublicationGrant({ kind: "PublicationGrant", body: grant }),
  );
  for (const suffix of ["\n", "\r\n", "\r", "\u2028", "\u2029", " "]) {
    for (const field of ["learner", "communityId", "issuedAt"] as const)
      assert.throws(() =>
        parsePublicationGrant({ ...grant, [field]: grant[field] + suffix }),
      );
  }
  for (const issuedAt of [
    1800000000,
    "01800000000",
    "1800000000000",
    "18446744073709551616",
    "1e9",
    "-1",
  ])
    assert.throws(() => parsePublicationGrant({ ...grant, issuedAt }));
});
test("exclusive grant window and correction reason are signed with no permissive repair", () => {
  assert.throws(() =>
    parsePublicationGrant({ ...grant, validAfter: grant.expiresAt }),
  );
  assert.throws(() =>
    parsePublicationGrant({ ...grant, submitBefore: grant.issuedAt }),
  );
  assert.throws(() =>
    parsePublicationGrant({ ...grant, permissionRevision: "0" }),
  );
  assert.throws(() =>
    parsePublicationCorrection({ ...correction, reasonHash: undefined }),
  );
  assert.notEqual(
    publicationCorrectionDigest(31337n, registry, correction),
    publicationCorrectionDigest(31337n, registry, {
      ...correction,
      reasonHash: digest("a"),
    }),
  );
  assert.throws(() => publicationDomain(1n, registry));
});
test("policy SHA-256 binds canonical purpose, retention, timing and distinct Dance Keccak", () => {
  const docs: DancePolicy = {
    rulesSha256: digest("1"),
    termsSha256: digest("2"),
    rubricSha256: digest("3"),
    mediaPolicySha256: digest("4"),
    consentDisclosureSha256: digest("5"),
    privacySha256: digest("6"),
  };
  const dance = dancePolicyHash(docs);
  const input = {
    schema: "pirate.publication-policy/1",
    purpose: "dance-verdict",
    termsSha256: digest("2"),
    disclosureSha256: digest("5"),
    privacySha256: digest("6"),
    retentionSha256: digest("7"),
    maxGrantDurationSeconds: "3600",
    maxSubmissionDelaySeconds: "600",
    dancePublicityPolicyHash: dance,
  };
  const policy = publicationPolicy(input);
  assert.equal(
    policy.policyHash,
    `0x${createHash("sha256").update(policy.bytes, "utf8").digest("hex")}`,
  );
  assert.notEqual(policy.policyHash, dance);
  assert.equal(
    verifyPublicationPolicy(input, policy).policyHash,
    policy.policyHash,
  );
  assert.throws(() =>
    verifyPublicationPolicy(input, {
      ...policy,
      maxGrantDurationSeconds: 3601n,
    }),
  );
  assert.throws(() =>
    verifyPublicationPolicy(input, {
      ...policy,
      dancePublicityPolicyHash: digest("a"),
    }),
  );
  assert.equal(
    publicationPolicy(Object.fromEntries(Object.entries(input).reverse()))
      .policyHash,
    policy.policyHash,
  );
  for (const change of [
    { purpose: "dance-review-attribution" },
    { retentionSha256: digest("8") },
    { termsSha256: digest("8") },
    { disclosureSha256: digest("8") },
    { maxGrantDurationSeconds: "3601" },
  ])
    assert.notEqual(
      publicationPolicy({ ...input, ...change }).policyHash,
      policy.policyHash,
    );
  assert.throws(() =>
    publicationPolicy({ ...input, purpose: "karaoke-results" }),
  );
  assert.throws(() =>
    publicationPolicy({ ...input, dancePublicityPolicyHash: digest("0") }),
  );
});

function result(): LearningResultV5 {
  return {
    sessionId: digest("7"),
    learner,
    grantId: digest("8"),
    song: {
      chainId: 31337n,
      posts: registry,
      communityId: grant.communityId,
      postId: digest("9"),
    },
    contentRevision: digest("1"),
    exercisesHash: keccak256("0x0001"),
    linesTotal: 1,
    activity: 1,
    grader: learner,
    scoringPolicy: digest("2"),
    qualificationPolicy: digest("0"),
    startedAt: 1800000000n,
    completedAt: 1800000000n,
    status: 1,
    revision: 1,
    supersedes: digest("0"),
  };
}
function log(
  r: LearningResultV5,
  outcomes: Hex,
  publisher: Address,
  configurationRevision: bigint,
) {
  const event = learningResultsV5Abi.find(
    (e) => e.type === "event" && e.name === "ResultPublishedV5",
  )!;
  const data = encodeAbiParameters(
    event.inputs.filter((i) => !i.indexed),
    [
      r,
      outcomes,
      learningCommitmentV5(r, outcomes),
      publisher,
      configurationRevision,
    ],
  );
  const topics = encodeEventTopics({
    abi: learningResultsV5Abi,
    eventName: "ResultPublishedV5",
    args: { sessionId: r.sessionId, learner: r.learner, revision: r.revision },
  });
  assert.ok(topics.length > 0 && topics.every((t) => typeof t === "string"));
  const exactTopics = [
    topics[0],
    ...topics.slice(1).map((t) => {
      assert.equal(typeof t, "string");
      if (typeof t !== "string") throw Error("invalid_topic");
      return t;
    }),
  ] as const;
  return { address: registry, data, topics: exactTopics, removed: false };
}
test("publisher rotation preserves original grader while authenticating correction executor", () => {
  assert.equal(
    learningCommitmentV5(result(), "0x0001012710"),
    "0x066c04db3a8f8825ad46458c8694dbe5b1cc64e1da5010596595d183afed7786",
  );
  const previous = { result: result(), outcomes: "0x0001012710" as Hex };
  const first = readLearningPublicationV5(
    log(previous.result, previous.outcomes, learner, 1n),
    { registry, publisherAtEvent: learner, configurationRevision: 1n },
  );
  const corrected = {
    ...previous.result,
    revision: 2,
    supersedes: first.commitment,
  };
  const next = log(corrected, "0x0001011388", publisherB, 2n);
  const read = readLearningPublicationV5(next, {
    registry,
    publisherAtEvent: publisherB,
    configurationRevision: 2n,
    previous,
  });
  assert.equal(read.result.grader, learner);
  assert.equal(read.publisher.toLowerCase(), publisherB);
  assert.equal(read.result.grantId, previous.result.grantId);
  assert.throws(() =>
    readLearningPublicationV5(next, {
      registry,
      publisherAtEvent: learner,
      configurationRevision: 2n,
      previous,
    }),
  );
  assert.throws(() =>
    readLearningPublicationV5(next, {
      registry,
      publisherAtEvent: publisherB,
      configurationRevision: 1n,
      previous,
    }),
  );
  assert.throws(() =>
    readLearningPublicationV5(
      log({ ...corrected, grader: publisherB }, "0x0001011388", publisherB, 2n),
      {
        registry,
        publisherAtEvent: publisherB,
        configurationRevision: 2n,
        previous,
      },
    ),
  );
});
test("historical decoder refuses removed logs, source swaps, missing prior and broken chain", () => {
  const r = result(),
    event = log(r, "0x0001012710", learner, 1n),
    expected = {
      registry,
      publisherAtEvent: learner,
      configurationRevision: 1n,
    };
  assert.throws(() =>
    readLearningPublicationV5({ ...event, removed: true }, expected),
  );
  assert.throws(() =>
    readLearningPublicationV5({ ...event, data: `${event.data}00` }, expected),
  );
  assert.throws(() =>
    readLearningPublicationV5({ ...event, address: learner }, expected),
  );
  assert.throws(() =>
    readLearningPublicationV5(
      log({ ...r, revision: 2 }, "0x0001012710", learner, 1n),
      expected,
    ),
  );
  assert.throws(() =>
    readLearningPublicationV5(
      log(
        { ...r, revision: 2, supersedes: digest("a") },
        "0x0001012710",
        learner,
        1n,
      ),
      { ...expected, previous: { result: r, outcomes: "0x0001012710" } },
    ),
  );
});
test("compiler-derived Dance command is V2, exact caller scoped and executable ABI", () => {
  const d = {
    chainId: 31337n,
    verifier: registry,
    communityId: grant.communityId,
  };
  const payload = {
    expectedOwnerEpoch: 1n,
    expectedConfigurationRevision: 1n,
    reviewerWallet: learner,
    expectedReviewerEpoch: 0n,
    expiresAtSeconds: 1800003600n,
  };
  const prepared = danceCommand(
    d,
    "grantReviewer",
    learner,
    digest("a"),
    payload,
  );
  assert.equal(
    prepared.hash,
    "0x4d91e59cb0398012c2d5217ee1b841e5a1517ce9e64f5b3f7ebcd3a61f3c66ee",
  );
  const decoded = decodeFunctionData({
    abi: danceVerdictsAbi,
    data: prepared.data,
  });
  assert.equal(decoded.functionName, "grantReviewer");
  assert.deepEqual(decoded.args, [prepared.id, prepared.hash, payload]);
  assert.notEqual(
    danceCommand(d, "grantReviewer", publisherB, digest("a"), payload).hash,
    prepared.hash,
  );
  assert.notEqual(
    danceCommand(
      { ...d, chainId: 6343n },
      "grantReviewer",
      learner,
      digest("a"),
      payload,
    ).hash,
    prepared.hash,
  );
});

test("fixed V2 capture and source vectors agree with actual Solidity Wire", () => {
  const d = {
    chainId: 31337n,
    verifier: registry,
    communityId: grant.communityId,
  };
  const capture = {
    captureId:
      "0x000000000000000000000000000000000000000000000000000000000000000b",
    accountCommitment:
      "0x000000000000000000000000000000000000000000000000000000000000000c",
    learner: "0x000000000000000000000000000000000000000d",
    identityEpoch: 14n,
    groupId:
      "0x000000000000000000000000000000000000000000000000000000000000000f",
    groupEpoch: 16n,
    publicationGrantId:
      "0x0000000000000000000000000000000000000000000000000000000000000011",
    reservedAtMs: 18n,
    song: {
      chainId: 19n,
      posts: "0x0000000000000000000000000000000000000014",
      communityId:
        "0x0000000000000000000000000000000000000000000000000000000000000015",
      postId:
        "0x0000000000000000000000000000000000000000000000000000000000000016",
      revision: 23n,
      manifestSha256:
        "0x0000000000000000000000000000000000000000000000000000000000000018",
      audioSha256:
        "0x0000000000000000000000000000000000000000000000000000000000000019",
    },
    rulesSha256:
      "0x000000000000000000000000000000000000000000000000000000000000001a",
    termsSha256:
      "0x000000000000000000000000000000000000000000000000000000000000001b",
    rubricSha256:
      "0x000000000000000000000000000000000000000000000000000000000000001c",
    mediaPolicySha256:
      "0x000000000000000000000000000000000000000000000000000000000000001d",
    referenceSelection: {
      present: false,
      id: "0x000000000000000000000000000000000000000000000000000000000000001f",
      revision: 32n,
      epoch: 33n,
      segmentLayoutSha256:
        "0x0000000000000000000000000000000000000000000000000000000000000022",
      segmentId:
        "0x0000000000000000000000000000000000000000000000000000000000000023",
      startSample: 36n,
      durationSamples: 37n,
    },
    offer: {
      present: false,
      offerIdCommitment:
        "0x0000000000000000000000000000000000000000000000000000000000000027",
      inputHash:
        "0x0000000000000000000000000000000000000000000000000000000000000028",
      sourceHash:
        "0x0000000000000000000000000000000000000000000000000000000000000029",
      opensAtMs: 42n,
      cutoffAtMs: 43n,
    },
  } as const;
  const source = {
    directory: "0x000000000000000000000000000000000000000b",
    directoryRuntimeHash:
      "0x000000000000000000000000000000000000000000000000000000000000000c",
    consentRegistry: "0x000000000000000000000000000000000000000d",
    consentRegistryRuntimeHash:
      "0x000000000000000000000000000000000000000000000000000000000000000e",
    posts: "0x000000000000000000000000000000000000000f",
    postsRuntimeHash:
      "0x0000000000000000000000000000000000000000000000000000000000000010",
    executionRule:
      "0x0000000000000000000000000000000000000000000000000000000000000011",
    learnerConsentPolicyHash:
      "0x0000000000000000000000000000000000000000000000000000000000000012",
    reviewerConsentPolicyHash:
      "0x0000000000000000000000000000000000000000000000000000000000000013",
    publicityPolicyHash:
      "0x0000000000000000000000000000000000000000000000000000000000000014",
    rulesSha256:
      "0x0000000000000000000000000000000000000000000000000000000000000015",
    termsSha256:
      "0x0000000000000000000000000000000000000000000000000000000000000016",
    rubricSha256:
      "0x0000000000000000000000000000000000000000000000000000000000000017",
    mediaPolicySha256:
      "0x0000000000000000000000000000000000000000000000000000000000000018",
    deploymentBlock: 25n,
    runtimeCodeHash:
      "0x000000000000000000000000000000000000000000000000000000000000001a",
  } as const;
  assert.equal(
    danceCaptureHash(d, capture),
    "0xfc029f11733ad947f0673c277f4e72489a1bc8de185561471f3d0f7f2651e3f0",
  );
  assert.equal(
    danceSourceHash(d, source),
    "0x201fee527872f0ad873918fbf89ddd330c5d259b633d727e7b58886ffe014170",
  );
});

// Boundary cases recorded before the proposed runtime adapter was installed.
// This extends the retained compiler-derived wire vectors, not live permission.
test("initial V5 publication binds original consent and all three contract arguments", (t) => {
  const { grantId: _oldGrant, ...facts } = result();
  const consent = preparePublicationGrant(31337n, registry, grant, "0x");
  const binding: BoundPublicationGrantV1 = {
    schema: "pirate.bound-publication-grant/1",
    source: { schema: "pirate.publication-source/1", resultsVersion: 5,
      chainId: 31337, communityId: grant.communityId, installationId: "vector-installation",
      directory: learner, directoryRuntimeHash: digest("a"), registry,
      registryRuntimeHash: grant.publicationTargetRuntimeHash, releaseSelectionSha256: digest("b") },
    grantId: consent.digest, grant: { ...grant, purpose: "karaoke-results" },
    recordedAtS: grant.issuedAt, boundAtS: grant.validAfter, localFenceGeneration: "0",
  };
  const outcomes = "0x0001012710" as const;
  const prepared = prepareInitialLearningV5(facts, outcomes, binding, "7");
  const decoded = decodeFunctionData({ abi: learningResultsV5Abi, data: prepared.calldata });
  assert.equal(decoded.functionName, "publish");
  assert.deepEqual(decoded.args, [{ ...facts, grantId: consent.digest }, outcomes, 7n]);
  assert.equal(prepared.result.grantId, consent.digest);
  // Reconstruct the protocol commitment independently from the compiled ABI.
  const publish = learningResultsV5Abi.find(x => x.type === "function" && x.name === "publish")!;
  const expectedCommitment = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, publish.inputs[0], { type: "bytes" }],
    [keccak256("0x7069726174652e6c6561726e696e672d726573756c742f35"),
      { ...facts, grantId: consent.digest }, outcomes],
  ));
  assert.equal(prepared.commitment, expectedCommitment);
  for (const oldField of ["grantId", "enrollmentId", "authorizationId"]) {
    assert.throws(() => prepareInitialLearningV5(
      { ...facts, [oldField]: digest("c") }, outcomes, binding, "7"), /invalid_v5_binding/);
  }
  for (const changed of [
    { ...binding, grantId: digest("d") },
    { ...binding, boundAtS: grant.expiresAt },
    { ...binding, recordedAtS: "1800000001" },
    { ...binding, source: { ...binding.source, communityId: digest("a") } },
    { ...binding, source: { ...binding.source, registryRuntimeHash: digest("a") } },
  ]) assert.throws(() => prepareInitialLearningV5(facts, outcomes, changed, "7"), /invalid_v5_publication/);
  for (const changed of [
    { ...facts, activity: 2 },
    { ...facts, learner: publisherB },
    { ...facts, startedAt: 1800000001n },
    { ...facts, completedAt: 1799999999n },
    { ...facts, revision: 2 },
    { ...facts, supersedes: digest("a") },
  ]) assert.throws(() => prepareInitialLearningV5(changed, outcomes, binding, "7"), /invalid_v5_publication/);
  assert.throws(() => prepareInitialLearningV5(facts, outcomes, binding, "0"), /invalid_v5_publication/);
  const studyGrant = { ...grant, purpose: "study-results" as const };
  const studyConsent = preparePublicationGrant(31337n, registry, studyGrant, "0x");
  const study = prepareInitialLearningV5({ ...facts, activity: 2 }, outcomes,
    { ...binding, grant: studyGrant, grantId: studyConsent.digest }, "7");
  assert.equal(study.result.grantId, studyConsent.digest);
  assert.equal(study.result.activity, 2);
  t.diagnostic(JSON.stringify({ artifact: "initial-v5-publication-wire/1",
    configurationRevision: "7", grantId: consent.digest, commitment: expectedCommitment,
    studyGrantId: studyConsent.digest, calldataSha256: createHash("sha256").update(prepared.calldata).digest("hex"),
    eligibility: "not-asserted", effects: 0 }));
});
