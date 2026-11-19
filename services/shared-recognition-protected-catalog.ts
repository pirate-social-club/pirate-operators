import type { Hex, PublicClient } from "viem";
import { createNativePostsChain, type NativePostsChainPolicy } from "../deploy/linux/web2-native-posts-chain.ts";
import { verifyRecord, type SignedRecord, type TrustAnchor } from "../deploy/linux/installed-records.ts";
import { exact, hashJson, insist, object } from "../packages/community/common.ts";
import type { IpfsTransport } from "../packages/community/ipfs.ts";
import { address, decimal } from "../packages/community/manifest-core.ts";
import type { canonicalCommunityClient } from "../packages/recognition/canonical-transport.ts";
import { ownerBudgetCeiling } from "../packages/release/owner-grant.ts";
import { managedDigest, type ManagedPublishingRegistration } from "../packages/release/managed-publishing-admission.ts";
import { createProtectedCatalogSelector } from "./protected-catalog-selection.ts";
import type { SharedReservationPorts } from "./shared-recognition-reservations.ts";

interface ProtectedCatalogInstallation {
  registrationSha256: Hex;
  applicationOriginalSha256: Hex;
  releaseSha256: Hex;
  retainedCustodySha256: Hex;
  proofSigner: string;
  feePolicy: { [K in keyof NativePostsChainPolicy]: string };
}

export interface ProtectedRecognitionCatalog {
  schema: "pirate.shared-recognition-protected-catalog/1";
  installations: ProtectedCatalogInstallation[];
}

const policyFields = [
  "genesisHash", "directoryCodeHash", "oracleProxyCodeHash", "oracleImplementation",
  "oracleImplementationCodeHash", "maximumSafeAgeSeconds", "maximumGas", "maximumGasPrice",
  "maximumTotalFee", "maximumOperatorFee",
] as const satisfies readonly (keyof NativePostsChainPolicy)[];

function nativeFeePolicy(value: unknown): NativePostsChainPolicy {
  const p = object(value);
  exact(p, policyFields);
  return {
    genesisHash: managedDigest(p.genesisHash),
    directoryCodeHash: managedDigest(p.directoryCodeHash),
    oracleProxyCodeHash: managedDigest(p.oracleProxyCodeHash),
    oracleImplementation: address(p.oracleImplementation),
    oracleImplementationCodeHash: managedDigest(p.oracleImplementationCodeHash),
    maximumSafeAgeSeconds: BigInt(decimal(p.maximumSafeAgeSeconds)),
    maximumGas: BigInt(decimal(p.maximumGas)),
    maximumGasPrice: BigInt(decimal(p.maximumGasPrice)),
    maximumTotalFee: BigInt(decimal(p.maximumTotalFee)),
    maximumOperatorFee: BigInt(decimal(p.maximumOperatorFee)),
  };
}

interface Installation {
  applicationOriginalSha256: Hex;
  releaseSha256: Hex;
  retainedCustodySha256: Hex;
  proofSigner: ReturnType<typeof address>;
  policy: NativePostsChainPolicy;
}

export function protectedRecognitionInstallations(
  signed: SignedRecord<ProtectedRecognitionCatalog>, trust: TrustAnchor,
  communities: readonly SignedRecord<ManagedPublishingRegistration>[],
  recognitionSigner: string,
) {
  exact(object(signed), ["schema", "keyId", "body", "signature"]);
  const body = structuredClone(verifyRecord(signed, trust));
  exact(object(body), ["schema", "installations"]);
  insist(body.schema === "pirate.shared-recognition-protected-catalog/1" && Array.isArray(body.installations) &&
    body.installations.length === communities.length, "protected_catalog_installation_unavailable", 503);
  const registrations = new Map(communities.map(record => [hashJson(record), record.body]));
  const installations = new Map<string, Installation>();
  for (const pin of body.installations) {
    exact(object(pin), ["registrationSha256", "applicationOriginalSha256", "releaseSha256",
      "retainedCustodySha256", "proofSigner", "feePolicy"]);
    const registration = registrations.get(managedDigest(pin.registrationSha256));
    insist(registration && !installations.has(registration.scope.communityId),
      "protected_catalog_installation_changed", 503);
    const proofSigner = address(pin.proofSigner), policy = nativeFeePolicy(pin.feePolicy);
    insist(proofSigner !== recognitionSigner && proofSigner !== registration.scope.publisher &&
      policy.directoryCodeHash === registration.deployment.directoryProfile.directoryCodeHash &&
      policy.maximumSafeAgeSeconds <= BigInt(registration.deployment.freshness.maxSafeBlockAgeSeconds) &&
      policy.maximumTotalFee <= BigInt(ownerBudgetCeiling(registration.grant, "post_fee_wei")),
    "protected_catalog_installation_changed", 503);
    installations.set(registration.scope.communityId, {
      applicationOriginalSha256: managedDigest(pin.applicationOriginalSha256),
      releaseSha256: managedDigest(pin.releaseSha256),
      retainedCustodySha256: managedDigest(pin.retainedCustodySha256), proofSigner, policy,
    });
  }
  return installations;
}

/** The publisher-signed remote original must agree with the service issuer's independent pins. */
export function configuredProtectedCatalog(input: {
  installation: Installation;
  registration: ManagedPublishingRegistration;
  community: Pick<ReturnType<typeof canonicalCommunityClient>, "protectedSelection">;
  client: PublicClient;
  ipfs: IpfsTransport;
}): NonNullable<SharedReservationPorts["protectedCatalog"]> {
  const { installation: pin, registration, community, client, ipfs } = input;
  const { deployment } = registration;
  const profile = { ...deployment.posts, deploymentBlock: BigInt(deployment.posts.deploymentBlock) };
  return async (authority, intent) => {
    const selected = await community.protectedSelection(intent, pin.proofSigner);
    const original = selected.original;
    insist(original.reference.installationId === registration.scope.installationId &&
      original.reference.releaseSha256 === pin.releaseSha256 &&
      original.applicationOriginalSha256 === pin.applicationOriginalSha256 &&
      original.retainedCustodySha256 === pin.retainedCustodySha256 &&
      original.grantSha256 === registration.grant.sha256 &&
      hashJson(original.configuration) === registration.configurationSha256,
    "protected_catalog_installation_changed", 503);
    const { readCanonicalOriginal } = createNativePostsChain({
      client, rpcUrl: deployment.rpcUrl, config: original.configuration, profile, policy: pin.policy,
    });
    return createProtectedCatalogSelector({
      readAdmittedOriginal: async () => selected, client, readCanonicalOriginal, limits: pin.policy, ipfs,
    })(authority, intent);
  };
}
