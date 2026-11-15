import { parseAbi, type Address, type Hex } from "viem";
import { exact, insist, object, hashText } from "./common.ts";
import { address, chain, decimal, httpsOrigin } from "./manifest-core.ts";
import { canonicalTld, directoryInstanceId, sharedBytes32, sharedNamespaceId } from "./shared-identity.ts";
import { directoryAbi } from "./directory-wire.ts";

export const acceptedSharedRegistry = Object.freeze({
  schema: "pirate.shared-registry-source/1",
  sourceCommit: "56d63ad2738e0e6816b6157dba7174198700f2fa",
  abiSha256: "0xe580c03988a02a6ecd1d414c7a3e0ac0e306c823e07b0f9a9078b30a06c3a802" as Hex,
});
// Explicit source-authored consumer ABI subset, NOT a compiled ABI/build attestation.
// Root must compare every entry with the actual V2 artifact before adoption.
export const sharedDirectoryAbi = [directoryAbi[0], directoryAbi[1], ...parseAbi([
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function proposeAdmin(address next)",
  "function acceptAdmin()",
  "function communityIdFor(bytes32 key) view returns (bytes32)",
  "function namespaceIdFor(string tld) pure returns (bytes32)",
  "function registrySource(address registry) view returns ((bytes32 runtimeCodeHash,bytes20 sourceCommit,bytes32 abiSha256))",
  "function admitRegistry(address registry,(bytes32 runtimeCodeHash,bytes20 sourceCommit,bytes32 abiSha256) source)",
  "function getBinding(bytes32 communityId) view returns ((bytes32 communityKey,bytes32 installationId,bytes32 originSha256,bytes32 namespaceId,bytes32 registryCodeHash,bytes20 sourceCommit,bytes32 abiSha256))",
  "function registerSharedCommunity(address registry,string tld,(bytes32 communityKey,bytes32 installationId,bytes32 originSha256,bytes32 namespaceId,bytes32 registryCodeHash,bytes20 sourceCommit,bytes32 abiSha256) binding,(address controller,address publisher,address operatorPayments,address learningRecords,bytes32 sha256Digest,string uri) configuration) returns (bytes32 communityId)",
  "function configure(bytes32 communityId,uint64 expectedRevision,(address controller,address publisher,address operatorPayments,address learningRecords,bytes32 sha256Digest,string uri) configuration)",
  "event CommunityBound(bytes32 indexed communityId,(bytes32 communityKey,bytes32 installationId,bytes32 originSha256,bytes32 namespaceId,bytes32 registryCodeHash,bytes20 sourceCommit,bytes32 abiSha256) binding)",
  "event CommunityRegistered(bytes32 indexed communityId,address indexed registry,bytes32 tldHash)",
  "event RegistryAdmitted(address indexed registry,(bytes32 runtimeCodeHash,bytes20 sourceCommit,bytes32 abiSha256) source)",
  "event AdminProposed(address indexed previousAdmin,address indexed proposedAdmin)",
  "event AdminAccepted(address indexed previousAdmin,address indexed newAdmin)",
])] as const;

export interface SharedDirectoryProfile {
  schema: "pirate.shared-directory/2";
  chainId: 6343 | 31337;
  directory: Address;
  directoryCodeHash: Hex;
  deploymentBlock: bigint;
  communityId: Hex;
  communityKey: Hex;
  installationId: Hex;
  hostingOrigin: string;
  registry: Address;
  registryCodeHash: Hex;
  registrySourceCommit: typeof acceptedSharedRegistry.sourceCommit;
  registryAbiSha256: Hex;
  tld: string;
  namespaceId: Hex;
}
export function validateSharedProfile(value: unknown): SharedDirectoryProfile {
  const p = object(value);
  exact(p, ["schema", "chainId", "directory", "directoryCodeHash", "deploymentBlock", "communityId",
    "communityKey", "installationId", "hostingOrigin", "registry", "registryCodeHash",
    "registrySourceCommit", "registryAbiSha256", "tld", "namespaceId"]);
  insist(p.schema === "pirate.shared-directory/2", "wrong_directory_schema");
  const chainId = chain(p.chainId), key = sharedBytes32(p.communityKey), tld = canonicalTld(p.tld);
  insist(typeof p.deploymentBlock === "bigint" && p.deploymentBlock >= 0n, "invalid_deployment_block");
  insist(p.registrySourceCommit === acceptedSharedRegistry.sourceCommit &&
    p.registryAbiSha256 === acceptedSharedRegistry.abiSha256, "unaccepted_registry_source");
  insist(p.communityId === directoryInstanceId(chainId, key) && p.namespaceId === sharedNamespaceId(tld),
    "shared_identity_mismatch");
  return {
    schema: "pirate.shared-directory/2", chainId, communityKey: key,
    directory: address(p.directory), directoryCodeHash: sharedBytes32(p.directoryCodeHash),
    deploymentBlock: p.deploymentBlock, communityId: sharedBytes32(p.communityId),
    installationId: sharedBytes32(p.installationId), hostingOrigin: httpsOrigin(p.hostingOrigin),
    registry: address(p.registry), registryCodeHash: sharedBytes32(p.registryCodeHash),
    registrySourceCommit: acceptedSharedRegistry.sourceCommit, registryAbiSha256: acceptedSharedRegistry.abiSha256,
    tld, namespaceId: sharedBytes32(p.namespaceId),
  };
}
export function sharedBinding(profile: SharedDirectoryProfile) {
  const p = validateSharedProfile(profile);
  return { communityKey: p.communityKey, installationId: p.installationId,
    originSha256: hashText(p.hostingOrigin), namespaceId: p.namespaceId,
    registryCodeHash: p.registryCodeHash, sourceCommit: `0x${p.registrySourceCommit}` as Hex,
    abiSha256: p.registryAbiSha256 };
}

export function sharedProfileDocument(profile: SharedDirectoryProfile) {
  const p = validateSharedProfile(profile);
  return { ...p, deploymentBlock: String(p.deploymentBlock) };
}
export function parseSharedProfileDocument(value: unknown): SharedDirectoryProfile {
  const p = object(value);
  return validateSharedProfile({ ...p, deploymentBlock: BigInt(decimal(p.deploymentBlock)) });
}
