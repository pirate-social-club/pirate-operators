// The pre-binding observation of the reviewed LearningResultsV4 deployment,
// against a real local-chain deployment. The local chain is 31337; the client
// reports the selection's chain 6343 so the fixed-chain rule applies, and every
// other read is the deployed contract's own state at the pinned block.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { chain } from "../harness/chain.ts";
import { accounts } from "../harness/runtime.ts";
import { observeLearningV4Release } from "../harness/learning-v4-release-observation.ts";
import type { LearningV4ReleaseSelection } from "../harness/learning-v4-release-profile.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { stopChain } from "./payments-fixture.ts";

type Chain = Awaited<ReturnType<typeof chain>>;
let evm: Chain;
const communityId = firstSong.directoryProfile.communityId as Hex;
const controller = accounts[3].address,
  publisher = accounts[2].address;
const expected = { communityId, publisher, communityOrigin: firstSong.origin };

/** A V4 deployment with both grader roles, mined below the observed head. */
async function deployV4(
  policy: Hex = learningV4PublicityPolicy,
  community = communityId,
  origin: string = firstSong.origin,
) {
  const contract = await evm.deploy("LearningResultsV4", [
    controller,
    community,
    policy,
    origin,
  ]);
  for (const activity of [1, 2])
    await evm.write(contract, "LearningResultsV4", "setGrader", [publisher, activity, true], 3);
  await evm.rpc("evm_mine", []);
  const code = await evm.publicClient.getCode({ address: contract });
  const selection: LearningV4ReleaseSelection = {
    schema: "pirate.learning-v4-release-selection/1",
    chainId: 6343,
    contract: contract.toLowerCase(),
    codeHash: keccak256(code!),
    controller: controller.toLowerCase(),
    publicationPolicy: learningV4PublicityPolicy,
    policyVersion: 4,
    communityOrigin: origin,
  };
  return { contract, selection };
}
/** The local chain's own reads, reporting the selection's chain id. */
const client = (chainId = 6343) =>
  ({
    getChainId: async () => chainId,
    getBlockNumber: (a: never) => evm.publicClient.getBlockNumber(a),
    getBlock: (a: never) => evm.publicClient.getBlock(a),
    getCode: (a: never) => evm.publicClient.getCode(a),
    readContract: (a: never) => evm.publicClient.readContract(a),
  }) as unknown as PublicClient;

before(async () => {
  evm = await chain(19977);
});
after(async () => {
  await stopChain(evm);
});

test("the reviewed V4 deployment is observed at a pinned block before it is bound", async () => {
  const { selection } = await deployV4();
  const head = await evm.publicClient.getBlockNumber();
  const observed = await observeLearningV4Release(client(), selection, expected);
  assert.equal(observed.blockNumber, (head - 1n).toString());
  assert.equal(
    observed.blockHash,
    (await evm.publicClient.getBlock({ blockNumber: head - 1n })).hash,
  );
  assert.equal(observed.selection.codeHash, selection.codeHash);
});

test("observation refuses a changed runtime code hash", async () => {
  const { selection } = await deployV4();
  await assert.rejects(
    observeLearningV4Release(
      client(),
      { ...selection, codeHash: "0x" + "4c".repeat(32) },
      expected,
    ),
    /^Error: learning_v4_release_code_changed$/,
  );
  // An address with no code is refused the same way.
  await assert.rejects(
    observeLearningV4Release(
      client(),
      { ...selection, contract: "0x" + "c4".repeat(20) },
      expected,
    ),
    /^Error: learning_v4_release_code_changed$/,
  );
});

test("observation refuses a contract whose VERSION is not 4", async () => {
  // A V3 deployment pinned by its own code hash.
  const v3 = await evm.deploy("LearningResultsV3", [
    controller,
    communityId,
    learningV4PublicityPolicy,
  ]);
  for (const activity of [1, 2])
    await evm.write(v3, "LearningResultsV3", "setGrader", [publisher, activity, true], 3);
  await evm.rpc("evm_mine", []);
  const { selection } = await deployV4();
  await assert.rejects(
    observeLearningV4Release(
      client(),
      {
        ...selection,
        contract: v3.toLowerCase(),
        codeHash: keccak256((await evm.publicClient.getCode({ address: v3 }))!),
      },
      expected,
    ),
    /^Error: learning_v4_release_version_changed$/,
  );
});

test("observation refuses another community", async () => {
  const other = keccak256(new TextEncoder().encode("another community"));
  const { selection } = await deployV4(learningV4PublicityPolicy, other);
  await assert.rejects(
    observeLearningV4Release(client(), selection, expected),
    /^Error: learning_v4_release_community_changed$/,
  );
});

test("observation refuses a publicity policy other than the V4 policy", async () => {
  const { selection } = await deployV4(
    keccak256(new TextEncoder().encode("another policy")),
  );
  await assert.rejects(
    observeLearningV4Release(client(), selection, expected),
    /^Error: learning_v4_release_policy_changed$/,
  );
});

test("observation refuses a contract whose sign-in names another community origin", async () => {
  // Deployed for another origin; the selection claims the right one.
  const { selection } = await deployV4(learningV4PublicityPolicy, communityId, "https://phish.example");
  assert.equal(selection.communityOrigin, "https://phish.example");
  await assert.rejects(
    observeLearningV4Release(client(), { ...selection, communityOrigin: firstSong.origin }, expected),
    /^Error: learning_v4_release_origin_changed$/,
  );
  // A selection that names the deployed origin is still not this community's.
  await assert.rejects(
    observeLearningV4Release(client(), selection, expected),
    /^Error: learning_v4_release_origin_changed$/,
  );
  // The right deployment against a selection naming another origin.
  const right = await deployV4();
  await assert.rejects(
    observeLearningV4Release(client(), { ...right.selection, communityOrigin: "https://phish.example" }, expected),
    /^Error: learning_v4_release_origin_changed$/,
  );
  // The selection itself must be a canonical origin.
  await assert.rejects(
    observeLearningV4Release(client(), { ...right.selection, communityOrigin: firstSong.origin + "/" }, expected),
    /^Error: learning_v4_release_selection_invalid$/,
  );
});

test("observation refuses a controller other than the selection's", async () => {
  const { contract, selection } = await deployV4();
  await evm.write(contract, "LearningResultsV4", "setController", [accounts[4].address], 3);
  await evm.rpc("evm_mine", []);
  await assert.rejects(
    observeLearningV4Release(client(), selection, expected),
    /^Error: learning_v4_release_controller_changed$/,
  );
});

for (const activity of [1, 2])
  test(`observation refuses a publisher without the activity ${activity} grader role`, async () => {
    const { contract, selection } = await deployV4();
    await evm.write(contract, "LearningResultsV4", "setGrader", [publisher, activity, false], 3);
    await evm.rpc("evm_mine", []);
    await assert.rejects(
      observeLearningV4Release(client(), selection, expected),
      /^Error: learning_v4_release_grader_missing$/,
    );
    // Another publisher is not the configured one.
    await evm.write(contract, "LearningResultsV4", "setGrader", [publisher, activity, true], 3);
    await evm.rpc("evm_mine", []);
    await assert.rejects(
      observeLearningV4Release(client(), selection, {
        ...expected,
        publisher: accounts[6].address as Address,
      }),
      /^Error: learning_v4_release_grader_missing$/,
    );
  });

test("observation refuses any chain but the selection's", async () => {
  const { selection } = await deployV4();
  await assert.rejects(
    observeLearningV4Release(client(31337), selection, expected),
    /^Error: learning_v4_release_wrong_chain$/,
  );
});

test("the release observes V4 before it binds LEARNING_RESULTS_V4_CONTRACT, and only when V4 is selected", async () => {
  const source = await readFile(
    new URL("../harness/community-release.ts", import.meta.url),
    "utf8",
  );
  const observed = source.indexOf(
    "if (learningV4)\n    await observeLearningV4Release(megaethReadClient(), learningV4);",
  );
  assert.ok(observed > 0);
  // After the plan-only return, before credentials, inventory and binding.
  assert.ok(observed > source.indexOf("if (!values.execute && !values.preflight)"));
  assert.ok(observed < source.indexOf("cfLoginToken(options, safe)"));
  assert.ok(observed < source.indexOf("LEARNING_RESULTS_V4_CONTRACT:"));
});
