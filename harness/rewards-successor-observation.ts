// Fixed-chain, block-pinned check of each result source a rewards release
// appends, run before the release binds REWARDS_RESULT_SUCCESSORS_JSON. It
// only reads. A source whose grader or policies do not match what results on
// the contract carry would close offers with no entries rather than fail, so
// those are observed here instead of trusted.
import { keccak256, parseAbi, type Address, type PublicClient } from "viem";
import { hashJson, insist } from "../packages/community/common.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  rewardsReleaseSelection,
  type RewardsReleaseSelection,
} from "./rewards-release-profile.ts";

const abi = parseAbi([
  "function VERSION() view returns (uint8)",
  "function communityId() view returns (bytes32)",
  "function graders(address,uint8) view returns (bool)",
  "function periodOf(uint64 timestamp) pure returns (uint64)",
  "function policyFor(uint8 activity,uint64 period) view returns (bytes32)",
]);
type Client = Pick<
  PublicClient,
  "getChainId" | "getBlockNumber" | "getBlock" | "getCode" | "readContract"
>;

export async function observeRewardSuccessors(
  client: Client,
  value: RewardsReleaseSelection,
  communityId: string = firstSong.directoryProfile.communityId,
  /** Successors the deployed predecessor already carries; observed when appended. */
  deployed: readonly unknown[] = [],
) {
  const selection = rewardsReleaseSelection(value);
  insist(
    (await client.getChainId()) === selection.profile.chainId,
    "reward_successor_wrong_chain",
    409,
  );
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head > 0n, "reward_successor_missing_head", 409);
  const blockNumber = head - 1n,
    block = await client.getBlock({ blockNumber });
  const observed = [];
  const known = new Set(deployed.map(hashJson));
  for (const source of selection.successors ?? []) {
    if (known.has(hashJson(source))) continue;
    const address = source.contract as Address;
    const read = (functionName: string, args?: readonly unknown[]) =>
      client.readContract({
        address,
        abi,
        functionName,
        ...(args ? { args } : {}),
        blockNumber,
      } as never) as Promise<unknown>;
    // The code is checked first: nothing is read from an unreviewed contract.
    const code = await client.getCode({ address, blockNumber });
    insist(
      !!code && code !== "0x" && keccak256(code) === source.codeHash,
      "reward_successor_code_changed",
      409,
    );
    insist(
      BigInt(source.fromBlock) <= blockNumber,
      "reward_successor_starts_later",
      409,
    );
    const [version, community, karaokeGrader, studyGrader, period] =
      await Promise.all([
        read("VERSION"),
        read("communityId"),
        read("graders", [source.grader, 1]),
        read("graders", [source.grader, 2]),
        read("periodOf", [block.timestamp]),
      ]);
    insist(
      Number(version) === source.version,
      "reward_successor_version_changed",
      409,
    );
    insist(
      String(community).toLowerCase() === communityId.toLowerCase(),
      "reward_successor_community_changed",
      409,
    );
    insist(
      karaokeGrader === true && studyGrader === true,
      "reward_successor_grader_missing",
      409,
    );
    // The latest period sees the last activation, so no rotation is already
    // scheduled. Activations are prospective: just after deployment the
    // current period may still have none, which no result can qualify under.
    const last = 2n ** 64n - 1n;
    const policies = await Promise.all([
      read("policyFor", [1, period]),
      read("policyFor", [2, period]),
      read("policyFor", [1, last]),
      read("policyFor", [2, last]),
    ]);
    insist(
      policies.every((policy, i) => {
        const value = String(policy).toLowerCase();
        return (
          value === (i % 2 === 0 ? source.karaokePolicy : source.studyPolicy) ||
          (i < 2 && BigInt(value) === 0n)
        );
      }),
      "reward_successor_policy_changed",
      409,
    );
    observed.push({ contract: source.contract, period: String(period) });
  }
  const checked = await client.getBlock({ blockNumber });
  insist(
    block.number === blockNumber &&
      checked.number === blockNumber &&
      !!block.hash &&
      block.hash === checked.hash,
    "reward_successor_canonical_block_changed",
    409,
  );
  return {
    chainId: selection.profile.chainId,
    blockNumber: blockNumber.toString(),
    blockHash: block.hash,
    observed,
  };
}
