import {
  getContractAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { insist } from "../../packages/community/common.ts";
import {
  runtimeMatches,
  type CommunityArtifact,
} from "../compile-community.ts";

export const registryProfile = {
  chainId: 6343,
  factory: "0x702185797cd23e153fd0b83b672f969ea4acfcc6" as Address,
  factoryCodeHash:
    "0x4bd9541c1194d770625f54d998407c0a9ae539a0d8d32ab998e2d4da0fbe17e8" as Hex,
  implementation: "0x1bfd3b5b227cfa1bd1e1ba8acf2855b7fcdfdfda" as Address,
  implementationCodeHash:
    "0x165fdfb3246f0ea9e4df8f1e9ce74f359ce907f20303dd65a5331539be186af0" as Hex,
};
export const factoryAbi = parseAbi([
  "function implementation() view returns(address)",
  "function isRegistry(address) view returns(bool)",
  "function deployRegistry(string tld,address admin,address treasury,uint256 annualPrice) returns(address)",
  "event RegistryDeployed(address indexed registry,string tld,address indexed admin,address indexed deployer)",
]);
const registryAbi = parseAbi([
  "function factory() view returns(address)",
  "function admin() view returns(address)",
  "function tld() view returns(string)",
]);
export async function verifyFactory(client: PublicClient) {
  insist((await client.getChainId()) === 6343, "refusing_non_megaeth_testnet");
  for (const [address, expected] of [
    [registryProfile.factory, registryProfile.factoryCodeHash],
    [registryProfile.implementation, registryProfile.implementationCodeHash],
  ] as const) {
    const code = await client.getCode({ address });
    insist(
      code && keccak256(code) === expected,
      "shared_registry_release_mismatch",
    );
  }
  const implementation = await client.readContract({
    address: registryProfile.factory,
    abi: factoryAbi,
    functionName: "implementation",
  });
  insist(
    implementation.toLowerCase() === registryProfile.implementation,
    "registry_implementation_changed",
  );
}
export async function verifyNewRegistry(
  client: PublicClient,
  receipt: TransactionReceipt,
  tld: string,
  operator: Address,
) {
  const events = parseEventLogs({
    abi: factoryAbi,
    logs: receipt.logs,
    eventName: "RegistryDeployed",
    strict: true,
  }).filter((log) => log.address.toLowerCase() === registryProfile.factory);
  insist(events.length === 1, "registry_deployment_event_missing");
  const event = events[0]!.args,
    registry = event.registry.toLowerCase() as Address;
  insist(
    event.tld === tld &&
      event.admin.toLowerCase() === operator.toLowerCase() &&
      event.deployer.toLowerCase() === operator.toLowerCase(),
    "registry_deployment_authority_mismatch",
  );
  const [code, known, factory, admin, label] = await Promise.all([
    client.getCode({ address: registry }),
    client.readContract({
      address: registryProfile.factory,
      abi: factoryAbi,
      functionName: "isRegistry",
      args: [registry],
    }),
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "factory",
    }),
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "admin",
    }),
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "tld",
    }),
  ]);
  const expected = `0x363d3d373d3d3d363d73${registryProfile.implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  insist(
    code?.toLowerCase() === expected &&
      known &&
      factory.toLowerCase() === registryProfile.factory &&
      admin.toLowerCase() === operator.toLowerCase() &&
      label === tld,
    "genuine_registry_verification_failed",
  );
  return {
    address: registry,
    runtimeCodeHash: keccak256(code!),
    admin: operator,
    tld,
    factory: registryProfile.factory,
  };
}
export async function verifyDeployment(
  client: PublicClient,
  receipt: TransactionReceipt,
  artifact: CommunityArtifact,
  signer: Address,
  nonce: number,
) {
  insist(
    receipt.contractAddress?.toLowerCase() ===
      getContractAddress({ from: signer, nonce: BigInt(nonce) }).toLowerCase(),
    "deployment_address_mismatch",
  );
  const address = receipt.contractAddress.toLowerCase() as Address,
    code = await client.getCode({ address });
  insist(code && runtimeMatches(code, artifact), "deployed_runtime_mismatch");
  return {
    address,
    runtimeCodeHash: keccak256(code),
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
  };
}
