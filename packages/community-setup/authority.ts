import { check } from "../protocol/index.ts";
import { resultsV4Abi } from "../protocol/learning-results-v4.ts";
import type { CommunitySetupV1 } from "./manifest.ts";
import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  parseAbi,
} from "viem";
export interface CommunityAuthorityReader {
  chainId(): Promise<number>;
  code(contract: string): Promise<string | undefined>;
  read(contract: string, method: string, args?: unknown[]): Promise<unknown>;
}
/** All reads share one block. No key, transaction or provider mutation. */
export async function communityAuthorityReader(
  rpcUrl: string,
): Promise<CommunityAuthorityReader> {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 5000, retryCount: 0 }),
  });
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const abi = [
    ...resultsV4Abi,
    ...parseAbi([
      "function controller() view returns (address)",
      "function graders(address grader,uint8 activity) view returns (bool)",
    ]),
  ];
  return {
    chainId: () => client.getChainId(),
    code: (contract) =>
      client.getCode({ address: contract as Address, blockNumber }),
    read: (contract, method, args = []) =>
      client.readContract({
        address: contract as Address,
        abi,
        functionName: method,
        args,
        blockNumber,
      } as never),
  };
}
/** Explicit acceptance probe. A prepared plan alone never satisfies it. */
export async function verifyCommunityAuthority(
  s: Pick<
    CommunitySetupV1,
    | "chainId"
    | "resultsContract"
    | "communityId"
    | "origin"
    | "owner"
    | "grader"
  >,
  publicityPolicy: Hex,
  reader: CommunityAuthorityReader,
) {
  check((await reader.chainId()) === s.chainId, "setup_chain_mismatch");
  const code = await reader.code(s.resultsContract);
  check(code && code !== "0x", "setup_contract_missing");
  const [community, origin, controller, policy, karaoke, study] =
    await Promise.all([
      reader.read(s.resultsContract, "communityId"),
      reader.read(s.resultsContract, "communityOrigin"),
      reader.read(s.resultsContract, "controller"),
      reader.read(s.resultsContract, "publicityPolicy"),
      reader.read(s.resultsContract, "graders", [s.grader, 1]),
      reader.read(s.resultsContract, "graders", [s.grader, 2]),
    ]);
  check(
    community === s.communityId &&
      origin === s.origin &&
      typeof controller === "string" &&
      controller.toLowerCase() === s.owner &&
      policy === publicityPolicy,
    "setup_contract_context_mismatch",
  );
  check(karaoke === true && study === true, "setup_grader_permission_missing");
  return {
    version: 1,
    chainId: s.chainId,
    contract: s.resultsContract,
    communityId: s.communityId,
    origin: s.origin,
    grader: s.grader,
    permissions: ["karaoke", "study"] as const,
  };
}
