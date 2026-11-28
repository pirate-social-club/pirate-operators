import type { Address, Hex } from "viem";
import { exact, hashText, insist, object, canonical } from "./common.ts";
import type { Web2CommunityConfig } from "./web2-config-manifest.ts";

export interface Web2InstallationReadbackMessage {
  enrollmentId: Hex;
  communityId: Hex;
  installationId: Hex;
  nonce: Hex;
  originHash: Hex;
  configurationDigest: Hex;
  publisher: Address;
}
export interface Web2InstallationReadbackProof extends Web2InstallationReadbackMessage {
  schema: "pirate.web2-installation-readback/1";
  signature: Hex;
}
const bytes32 = (value: unknown): Hex => {
  insist(typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value), "installation_readback_invalid", 503);
  return value as Hex;
};
export function installationReadbackMessage(input: {
  enrollmentId: Hex;
  config: Web2CommunityConfig;
  nonce: Hex;
}): Web2InstallationReadbackMessage {
  const config = input.config;
  return {
    enrollmentId: input.enrollmentId,
    communityId: config.communityId,
    installationId: config.installationId,
    nonce: input.nonce,
    originHash: hashText(config.app.origin),
    configurationDigest: hashText(canonical(config)),
    publisher: config.publisher,
  };
}
export function installationReadbackTypedData(
  config: Pick<Web2CommunityConfig, "chainId" | "directory">,
  message: Web2InstallationReadbackMessage,
) {
  return {
    domain: {
      name: "Pirate Web2 installation readback",
      version: "1",
      chainId: config.chainId,
      verifyingContract: config.directory,
    },
    types: {
      InstallationReadback: [
        { name: "enrollmentId", type: "bytes32" },
        { name: "communityId", type: "bytes32" },
        { name: "installationId", type: "bytes32" },
        { name: "nonce", type: "bytes32" },
        { name: "originHash", type: "bytes32" },
        { name: "configurationDigest", type: "bytes32" },
        { name: "publisher", type: "address" },
      ],
    },
    primaryType: "InstallationReadback",
    message,
  } as const;
}
export function parseInstallationReadbackProof(value: unknown): Web2InstallationReadbackProof {
  const row = object(value);
  exact(row, [
    "schema",
    "enrollmentId",
    "communityId",
    "installationId",
    "nonce",
    "originHash",
    "configurationDigest",
    "publisher",
    "signature",
  ]);
  insist(row.schema === "pirate.web2-installation-readback/1", "installation_readback_invalid", 503);
  insist(typeof row.publisher === "string" && /^0x[0-9a-f]{40}$/.test(row.publisher), "installation_readback_invalid", 503);
  insist(typeof row.signature === "string" && /^0x(?:[0-9a-fA-F]{2}){65,1024}$/.test(row.signature), "installation_readback_invalid", 503);
  return {
    schema: "pirate.web2-installation-readback/1",
    enrollmentId: bytes32(row.enrollmentId),
    communityId: bytes32(row.communityId),
    installationId: bytes32(row.installationId),
    nonce: bytes32(row.nonce),
    originHash: bytes32(row.originHash),
    configurationDigest: bytes32(row.configurationDigest),
    publisher: row.publisher as Address,
    signature: row.signature as Hex,
  };
}
