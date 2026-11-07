// Fixed-chain, block-pinned identity check. No signing or deployment code.
import { keccak256, parseAbi, type PublicClient } from "viem";
import { insist } from "../packages/community/common.ts";
import {
  studyReleaseSelection,
  retainedLearningOperator,
  type StudyReleaseSelection,
} from "./study-release-profile.ts";
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
export async function observeStudyRelease(
  client: Client,
  value: StudyReleaseSelection,
) {
  const selection = studyReleaseSelection(value);
  insist(
    (await client.getChainId()) === 6343,
    "study_release_wrong_chain",
    409,
  );
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head > 0n, "study_release_missing_head", 409);
  const blockNumber = head - 1n,
    address = selection.resultsV3.contract;
  const [
    block,
    v2,
    v3,
    version,
    community,
    publicity,
    controller,
    karaoke,
    study,
  ] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.getCode({ address: selection.resultsV2.contract, blockNumber }),
    client.getCode({ address, blockNumber }),
    client.readContract({ address, abi, functionName: "VERSION", blockNumber }),
    client.readContract({
      address,
      abi,
      functionName: "communityId",
      blockNumber,
    }),
    client.readContract({
      address,
      abi,
      functionName: "publicityPolicy",
      blockNumber,
    }),
    client.readContract({
      address,
      abi,
      functionName: "controller",
      blockNumber,
    }),
    client.readContract({
      address,
      abi,
      functionName: "graders",
      args: [retainedLearningOperator.publisher, 1],
      blockNumber,
    }),
    client.readContract({
      address,
      abi,
      functionName: "graders",
      args: [retainedLearningOperator.publisher, 2],
      blockNumber,
    }),
  ]);
  insist(
    v2 &&
      v3 &&
      keccak256(v2) === selection.resultsV2.codeHash &&
      keccak256(v3) === selection.resultsV3.codeHash,
    "study_release_code_changed",
    409,
  );
  insist(
    version === 3 &&
      community === selection.communityId &&
      publicity === selection.resultsV3.publicityPolicy &&
      String(controller).toLowerCase() === selection.controller &&
      karaoke === true &&
      study === true,
    "study_release_contract_state_changed",
    409,
  );
  const checked = await client.getBlock({ blockNumber });
  insist(
    block.number === blockNumber &&
      checked.number === blockNumber &&
      block.hash &&
      block.hash === checked.hash,
    "study_release_canonical_block_changed",
    409,
  );
  return {
    chainId: 6343,
    blockNumber: blockNumber.toString(),
    blockHash: block.hash,
    selection,
  };
}
