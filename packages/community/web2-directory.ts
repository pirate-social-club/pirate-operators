import { type Address, type Hex } from "viem";
import { exact, insist, object } from "./common.ts";
import { address, chain } from "./manifest-core.ts";
import { directoryInstanceId, sharedBytes32 } from "./shared-identity.ts";
import { directoryV3Abi, directoryV3Build } from "./generated/directory-v3.ts";
export { directoryV3Abi, directoryV3Build } from "./generated/directory-v3.ts";

export interface Web2DirectoryProfile {
  schema: "pirate.web2-directory/3";
  chainId: 6343 | 31337;
  directory: Address;
  directoryCodeHash: Hex;
  directoryAbiSha256: Hex;
  sourceCommit: string;
  deploymentBlock: bigint;
  communityId: Hex;
  communityKey: Hex;
  installationId: Hex;
}
export function validateWeb2Profile(
  value: unknown,
): Readonly<Web2DirectoryProfile> {
  const p = object(value);
  exact(p, [
    "schema",
    "chainId",
    "directory",
    "directoryCodeHash",
    "directoryAbiSha256",
    "sourceCommit",
    "deploymentBlock",
    "communityId",
    "communityKey",
    "installationId",
  ]);
  insist(p.schema === "pirate.web2-directory/3", "wrong_directory_schema");
  const chainId = chain(p.chainId),
    key = sharedBytes32(p.communityKey);
  insist(
    p.directoryCodeHash === directoryV3Build.runtimeCodeHash &&
      p.directoryAbiSha256 === directoryV3Build.abiSha256,
    "unaccepted_directory_build",
  );
  insist(
    typeof p.sourceCommit === "string" &&
      /^[0-9a-f]{40}(?![\s\S])/.test(p.sourceCommit),
    "invalid_directory_source_commit",
  );
  insist(
    typeof p.deploymentBlock === "bigint" && p.deploymentBlock >= 0n,
    "invalid_deployment_block",
  );
  insist(
    p.communityId === directoryInstanceId(chainId, key),
    "community_identity_mismatch",
  );
  return Object.freeze({
    schema: "pirate.web2-directory/3",
    chainId,
    directory: address(p.directory),
    directoryCodeHash: directoryV3Build.runtimeCodeHash,
    directoryAbiSha256: directoryV3Build.abiSha256,
    sourceCommit: p.sourceCommit,
    deploymentBlock: p.deploymentBlock,
    communityId: sharedBytes32(p.communityId),
    communityKey: key,
    installationId: sharedBytes32(p.installationId),
  });
}
export function web2Binding(profile: Web2DirectoryProfile) {
  const p = validateWeb2Profile(profile);
  return Object.freeze({
    communityKey: p.communityKey,
    installationId: p.installationId,
  });
}
export function web2ProfileDocument(profile: Web2DirectoryProfile) {
  const p = validateWeb2Profile(profile);
  return { ...p, deploymentBlock: String(p.deploymentBlock) };
}
export function parseWeb2ProfileDocument(value: unknown) {
  const p = object(value);
  insist(
    typeof p.deploymentBlock === "string" &&
      /^(0|[1-9][0-9]{0,77})(?![\s\S])/.test(p.deploymentBlock),
    "invalid_deployment_block",
  );
  return validateWeb2Profile({
    ...p,
    deploymentBlock: BigInt(p.deploymentBlock),
  });
}
