// Fixed-chain, block-pinned identity check of the reviewed LearningResultsV4
// deployment, run before a release binds LEARNING_RESULTS_V4_CONTRACT. No
// signing or deployment code; it only reads.
import { keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { insist } from "../packages/community/common.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  learningV4ReleaseSelection,
  type LearningV4ReleaseSelection,
} from "./learning-v4-release-profile.ts";
import { retainedLearningOperator } from "./study-release-profile.ts";
const abi = parseAbi([
  "function VERSION() view returns (uint8)",
  "function communityId() view returns (bytes32)",
  "function publicityPolicy() view returns (bytes32)",
  "function controller() view returns (address)",
  "function graders(address,uint8) view returns (bool)",
]);
type Client = Pick<
  PublicClient,
  "getChainId" | "getBlockNumber" | "getBlock" | "getCode" | "readContract"
>;
export interface LearningV4ReleaseExpectation {
  /** The community the deployed contract must name. */
  communityId: Hex;
  /** The operator publisher that must hold the Karaoke and Study grader roles. */
  publisher: Address;
}
export const learningV4ReleaseExpectation: LearningV4ReleaseExpectation = {
  communityId: firstSong.directoryProfile.communityId as Hex,
  publisher: retainedLearningOperator.publisher,
};

export async function observeLearningV4Release(
  client: Client,
  value: LearningV4ReleaseSelection,
  expected: LearningV4ReleaseExpectation = learningV4ReleaseExpectation,
) {
  const selection = learningV4ReleaseSelection(value);
  insist(
    (await client.getChainId()) === selection.chainId,
    "learning_v4_release_wrong_chain",
    409,
  );
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head > 0n, "learning_v4_release_missing_head", 409);
  const blockNumber = head - 1n,
    address = selection.contract as Address;
  const read = (functionName: string, args?: readonly unknown[]) =>
    client.readContract({
      address,
      abi,
      functionName,
      ...(args ? { args } : {}),
      blockNumber,
    } as never) as Promise<unknown>;
  // The code is checked first: nothing is read from an unreviewed contract.
  const [block, code] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.getCode({ address, blockNumber }),
  ]);
  insist(
    !!code && code !== "0x" && keccak256(code) === selection.codeHash,
    "learning_v4_release_code_changed",
    409,
  );
  const [version, community, publicity, controller, karaoke, study] =
    await Promise.all([
      read("VERSION"),
      read("communityId"),
      read("publicityPolicy"),
      read("controller"),
      read("graders", [expected.publisher, 1]),
      read("graders", [expected.publisher, 2]),
    ]);
  insist(Number(version) === 4, "learning_v4_release_version_changed", 409);
  insist(
    String(community).toLowerCase() === expected.communityId.toLowerCase(),
    "learning_v4_release_community_changed",
    409,
  );
  insist(
    publicity === learningV4PublicityPolicy &&
      publicity === selection.publicationPolicy,
    "learning_v4_release_policy_changed",
    409,
  );
  insist(
    String(controller).toLowerCase() === selection.controller,
    "learning_v4_release_controller_changed",
    409,
  );
  insist(
    karaoke === true && study === true,
    "learning_v4_release_grader_missing",
    409,
  );
  const checked = await client.getBlock({ blockNumber });
  insist(
    block.number === blockNumber &&
      checked.number === blockNumber &&
      !!block.hash &&
      block.hash === checked.hash,
    "learning_v4_release_canonical_block_changed",
    409,
  );
  return {
    chainId: selection.chainId,
    blockNumber: blockNumber.toString(),
    blockHash: block.hash,
    selection,
  };
}
