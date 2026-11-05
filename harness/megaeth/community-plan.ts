import { encodeDeployData, type Address, type PublicClient } from "viem";
import { insist } from "../../packages/community/common.ts";
import type { CommunityArtifact } from "../compile-community.ts";
import { registryProfile } from "./verify-community.ts";
export const deploymentGas = {
  registry: 1000000n,
  authority: 300000n,
  directory: 150000000n,
  posts: 80000000n,
};
export const deploymentLimits = {
  chainId: 6343 as const,
  maximumGasPrice: 30000000n,
  maximumTotalFee: 10000000000000000n,
  maximumExecutionMs: 600000,
};

/** Read-only gas preflight with representative addresses that already contain
 * code. Actual execution always uses the reviewed inert authorities/directory
 * and repeats estimation for its exact constructor inputs before signing. */
export async function estimatePlanGas(
  client: PublicClient,
  operator: Address,
  artifacts: Record<string, CommunityArtifact>,
  limits: { authority: bigint; directory: bigint; posts: bigint },
) {
  const estimates = await Promise.all([
    client.estimateGas({
      account: operator,
      data: artifacts.DisabledDiscoveryAuthority!.bytecode,
    }),
    client.estimateGas({
      account: operator,
      data: encodeDeployData({
        abi: artifacts.CommunityDirectoryV1!.abi,
        bytecode: artifacts.CommunityDirectoryV1!.bytecode,
        args: [
          [registryProfile.factory],
          registryProfile.factory,
          registryProfile.implementation,
          86400n,
        ],
      }),
    }),
    client.estimateGas({
      account: operator,
      data: encodeDeployData({
        abi: artifacts.CommunityPostsV1!.abi,
        bytecode: artifacts.CommunityPostsV1!.bytecode,
        args: [registryProfile.factory],
      }),
    }),
  ]);
  insist(
    estimates[0] <= limits.authority &&
      estimates[1] <= limits.directory &&
      estimates[2] <= limits.posts,
    "remaining_deployment_gas_cap_too_small",
  );
  return estimates;
}
