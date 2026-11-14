import { keccak256, type PublicClient } from "viem";
import { insist } from "../../packages/community/common.ts";
import { sharedDirectoryAbi } from "../../packages/community/shared-directory.ts";
import { prepareSharedRegistration, type SharedRegistrationPlan } from "../../packages/community/shared-registration-chain.ts";

// Read-only pre-signing check. Caller must hold its original-operation lease and
// durably persist exact signed bytes before any separately authorized broadcast.
export async function inspectSharedSetup(client: PublicClient, plan: SharedRegistrationPlan) {
  const exact = prepareSharedRegistration(plan.profile, plan.config, plan.uri, plan.admin);
  insist(plan.schema === exact.schema && plan.commitment === exact.commitment && plan.data === exact.data, "registration_plan_changed");
  const p = exact.profile;
  insist((await client.getChainId()) === p.chainId, "wrong_application_chain");
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head > p.deploymentBlock, "directory_not_confirmed");
  const blockNumber = head - 1n;
  const [block, code, admin, source, registryCode] = await Promise.all([
    client.getBlock({ blockNumber }), client.getCode({ address: p.directory, blockNumber }),
    client.readContract({ address: p.directory, abi: sharedDirectoryAbi, functionName: "admin", blockNumber }),
    client.readContract({ address: p.directory, abi: sharedDirectoryAbi, functionName: "registrySource", args: [p.registry], blockNumber }),
    client.getCode({ address: p.registry, blockNumber }),
  ]);
  insist(code && keccak256(code) === p.directoryCodeHash && admin.toLowerCase() === exact.admin && registryCode &&
    keccak256(registryCode) === p.registryCodeHash && source.runtimeCodeHash === p.registryCodeHash &&
    source.sourceCommit === `0x${p.registrySourceCommit}` && source.abiSha256 === p.registryAbiSha256,
    "shared_setup_source_or_role_changed");
  insist((await client.getBlock({ blockNumber })).hash === block.hash, "directory_chain_reorganized");
  return { blockNumber, blockHash: block.hash, plan: exact, issuanceAuthorized: false as const };
}
