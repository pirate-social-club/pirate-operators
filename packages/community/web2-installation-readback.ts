import type { Address, Hex } from "viem";
import { exact, hashText, insist, object, canonical } from "./common.ts";
import type { Web2CommunityConfig } from "./web2-config-manifest.ts";

export interface Web2InstallationReadbackBinding {
  generation: number;
  planId: string;
  durableScope: string;
  releaseArtifactDigest: Hex;
  releaseSourceDigest: Hex;
  targetDigest: string;
  hostFingerprint: string;
}
export interface Web2InstallationReadbackMessage
  extends Web2InstallationReadbackBinding {
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
  installation: Web2InstallationReadbackBinding;
}): Web2InstallationReadbackMessage {
  const config = input.config,
    installation = input.installation;
  return {
    enrollmentId: input.enrollmentId,
    communityId: config.communityId,
    installationId: config.installationId,
    nonce: input.nonce,
    generation: installation.generation,
    planId: installation.planId,
    durableScope: installation.durableScope,
    releaseArtifactDigest: installation.releaseArtifactDigest,
    releaseSourceDigest: installation.releaseSourceDigest,
    targetDigest: installation.targetDigest,
    hostFingerprint: installation.hostFingerprint,
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
        { name: "generation", type: "uint64" },
        { name: "planId", type: "string" },
        { name: "durableScope", type: "string" },
        { name: "releaseArtifactDigest", type: "bytes32" },
        { name: "releaseSourceDigest", type: "bytes32" },
        { name: "targetDigest", type: "string" },
        { name: "hostFingerprint", type: "string" },
        { name: "originHash", type: "bytes32" },
        { name: "configurationDigest", type: "bytes32" },
        { name: "publisher", type: "address" },
      ],
    },
    primaryType: "InstallationReadback",
    message: { ...message, generation: BigInt(message.generation) },
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
    "generation",
    "planId",
    "durableScope",
    "releaseArtifactDigest",
    "releaseSourceDigest",
    "targetDigest",
    "hostFingerprint",
    "originHash",
    "configurationDigest",
    "publisher",
    "signature",
  ]);
  insist(row.schema === "pirate.web2-installation-readback/1", "installation_readback_invalid", 503);
  insist(typeof row.publisher === "string" && /^0x[0-9a-f]{40}$/.test(row.publisher), "installation_readback_invalid", 503);
  insist(
    Number.isSafeInteger(row.generation) && (row.generation as number) > 0 &&
      typeof row.planId === "string" && row.planId.length <= 128 &&
      typeof row.durableScope === "string" && /^[0-9a-f]{64}$/.test(row.durableScope) &&
      typeof row.targetDigest === "string" && /^[0-9a-f]{64}$/.test(row.targetDigest) &&
      typeof row.hostFingerprint === "string" && row.hostFingerprint.length > 0 && row.hostFingerprint.length <= 256,
    "installation_readback_invalid",
    503,
  );
  insist(typeof row.signature === "string" && /^0x(?:[0-9a-fA-F]{2}){65,1024}$/.test(row.signature), "installation_readback_invalid", 503);
  return {
    schema: "pirate.web2-installation-readback/1",
    enrollmentId: bytes32(row.enrollmentId),
    communityId: bytes32(row.communityId),
    installationId: bytes32(row.installationId),
    nonce: bytes32(row.nonce),
    generation: row.generation as number,
    planId: row.planId as string,
    durableScope: row.durableScope as string,
    releaseArtifactDigest: bytes32(row.releaseArtifactDigest),
    releaseSourceDigest: bytes32(row.releaseSourceDigest),
    targetDigest: row.targetDigest as string,
    hostFingerprint: row.hostFingerprint as string,
    originHash: bytes32(row.originHash),
    configurationDigest: bytes32(row.configurationDigest),
    publisher: row.publisher as Address,
    signature: row.signature as Hex,
  };
}
