import { exact, insist, integer, object } from "./common.ts";
import { sharedBytes32 } from "./shared-identity.ts";
import { signature } from "./hosted-enrollment.ts";
import type { Web2DirectoryProfile } from "./web2-directory.ts";
import type { Hex } from "viem";

export interface Web2InstallationPlanCommitment {
  schema: "pirate.web2-installation-plan-commitment/1";
  enrollmentId: Hex;
  communityId: Hex;
  installationId: Hex;
  generation: number;
  planId: string;
  durableScope: string;
  releaseArtifactDigest: Hex;
  releaseSourceDigest: Hex;
  targetDigest: string;
  hostFingerprint: string;
  controllerSignature: Hex;
}
function hex64(value: unknown): string {
  insist(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "invalid_installation_commitment");
  return value;
}
function label(value: unknown, maximum = 256): string {
  insist(typeof value === "string" && value.length > 0 && value.length <= maximum, "invalid_installation_commitment");
  return value;
}
export function parseInstallationPlanCommitment(value: unknown): Web2InstallationPlanCommitment {
  const row = object(value);
  exact(row, ["schema","enrollmentId","communityId","installationId","generation","planId","durableScope","releaseArtifactDigest","releaseSourceDigest","targetDigest","hostFingerprint","controllerSignature"]);
  insist(row.schema === "pirate.web2-installation-plan-commitment/1", "invalid_installation_commitment");
  return {
    schema: row.schema,
    enrollmentId: sharedBytes32(row.enrollmentId),
    communityId: sharedBytes32(row.communityId),
    installationId: sharedBytes32(row.installationId),
    generation: integer(row.generation, 1, Number.MAX_SAFE_INTEGER),
    planId: label(row.planId, 128),
    durableScope: hex64(row.durableScope),
    releaseArtifactDigest: sharedBytes32(row.releaseArtifactDigest),
    releaseSourceDigest: sharedBytes32(row.releaseSourceDigest),
    targetDigest: hex64(row.targetDigest),
    hostFingerprint: label(row.hostFingerprint),
    controllerSignature: signature(row.controllerSignature),
  };
}

export function unsignedInstallationPlanCommitment(input: {
  enrollmentId: Hex;
  communityId: Hex;
  installationId: Hex;
  generation: number;
  planId: string;
  durableScope: string;
  releaseArtifactDigest: Hex;
  releaseSourceDigest: Hex;
  targetDigest: string;
  hostFingerprint: string;
}): Omit<Web2InstallationPlanCommitment, "schema" | "controllerSignature"> {
  return {
    enrollmentId: sharedBytes32(input.enrollmentId),
    communityId: sharedBytes32(input.communityId),
    installationId: sharedBytes32(input.installationId),
    generation: integer(input.generation, 1, Number.MAX_SAFE_INTEGER),
    planId: label(input.planId, 128),
    durableScope: hex64(input.durableScope),
    releaseArtifactDigest: sharedBytes32(input.releaseArtifactDigest),
    releaseSourceDigest: sharedBytes32(input.releaseSourceDigest),
    targetDigest: hex64(input.targetDigest),
    hostFingerprint: label(input.hostFingerprint),
  };
}

export function installationPlanCommitmentTypedData(
  profile: Web2DirectoryProfile,
  value: Omit<Web2InstallationPlanCommitment, "schema" | "controllerSignature">,
) {
  return {
    domain: {
      name: "Pirate Web2 Installation Plan",
      version: "1",
      chainId: profile.chainId,
      verifyingContract: profile.directory,
    },
    primaryType: "InstallationPlan" as const,
    types: {
      InstallationPlan: [
        { name: "enrollmentId", type: "bytes32" },
        { name: "communityId", type: "bytes32" },
        { name: "installationId", type: "bytes32" },
        { name: "generation", type: "uint64" },
        { name: "planId", type: "string" },
        { name: "durableScope", type: "bytes32" },
        { name: "releaseArtifactDigest", type: "bytes32" },
        { name: "releaseSourceDigest", type: "bytes32" },
        { name: "targetDigest", type: "bytes32" },
        { name: "hostFingerprint", type: "string" },
      ],
    },
    message: {
      ...value,
      generation: String(value.generation),
      durableScope: `0x${value.durableScope}` as Hex,
      targetDigest: `0x${value.targetDigest}` as Hex,
    },
  };
}
