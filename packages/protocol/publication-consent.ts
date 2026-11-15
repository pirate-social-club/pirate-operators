import {
  encodeFunctionData,
  hashTypedData,
  sha256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { canonical, exact, insist, object } from "../community/common.ts";
import {
  publicationConsentAbi,
  publicationConsentTypes,
} from "./generated/publication-consent-v1.ts";

export const publicationPurposes = [
  "karaoke-results",
  "study-results",
  "dance-verdict",
  "dance-review-attribution",
] as const;
export type PublicationPurpose = (typeof publicationPurposes)[number];
const zero = `0x${"0".repeat(64)}`;
export function consentDigest(value: unknown, allowZero = false): Hex {
  insist(
    typeof value === "string" &&
      /^0x[0-9a-f]{64}(?![\s\S])/.test(value) &&
      (allowZero || value !== zero),
    "invalid_consent_digest",
  );
  return value as Hex;
}
export function consentAddress(value: unknown): Address {
  insist(
    typeof value === "string" &&
      /^0x[0-9a-f]{40}(?![\s\S])/.test(value) &&
      BigInt(value) !== 0n,
    "invalid_consent_address",
  );
  return value as Address;
}
export function consentUint64(value: unknown): bigint {
  insist(
    typeof value === "string" && /^(0|[1-9][0-9]{0,19})(?![\s\S])/.test(value),
    "invalid_consent_uint64",
  );
  const n = BigInt(value);
  insist(n <= 18446744073709551615n, "invalid_consent_uint64");
  return n;
}
function seconds(value: unknown): bigint {
  const n = consentUint64(value);
  // Transport uses UTC seconds representable through year 9999, never JS date milliseconds.
  insist(n > 0n && n <= 253402300799n, "invalid_consent_seconds");
  return n;
}
function purpose(value: unknown): PublicationPurpose {
  insist(
    publicationPurposes.some((p) => p === value),
    "invalid_publication_purpose",
  );
  return value as PublicationPurpose;
}
type Primary = keyof typeof publicationConsentTypes;
function fields(value: unknown, primary: Primary) {
  const v = object(value);
  exact(
    v,
    publicationConsentTypes[primary].map((f) => f.name),
  );
  return v;
}
export function publicationDomain(chainId: bigint, verifyingContract: Address) {
  insist(chainId === 6343n || chainId === 31337n, "unsupported_consent_chain");
  return {
    name: "Pirate Publication Consent",
    version: "1",
    chainId,
    verifyingContract: consentAddress(verifyingContract),
  } as const;
}
export function parsePublicationGrant(value: unknown) {
  const v = fields(value, "PublicationGrant");
  const result = {
    learner: consentAddress(v.learner),
    communityId: consentDigest(v.communityId),
    purpose: purpose(v.purpose),
    publicationTarget: consentAddress(v.publicationTarget),
    publicationTargetRuntimeHash: consentDigest(v.publicationTargetRuntimeHash),
    permissionRevision: consentUint64(v.permissionRevision),
    policyHash: consentDigest(v.policyHash),
    withdrawalEpoch: consentUint64(v.withdrawalEpoch),
    nonce: consentDigest(v.nonce),
    issuedAt: seconds(v.issuedAt),
    validAfter: seconds(v.validAfter),
    expiresAt: seconds(v.expiresAt),
    submitBefore: seconds(v.submitBefore),
  };
  insist(
    result.permissionRevision > 0n &&
      result.issuedAt <= result.validAfter &&
      result.validAfter < result.expiresAt &&
      result.issuedAt < result.submitBefore &&
      result.submitBefore <= result.expiresAt,
    "invalid_consent_window",
  );
  return Object.freeze(result);
}
export type PublicationGrant = ReturnType<typeof parsePublicationGrant>;
export function parsePublicationWithdrawal(value: unknown) {
  const v = fields(value, "PublicationWithdrawal");
  return Object.freeze({
    learner: consentAddress(v.learner),
    communityId: consentDigest(v.communityId),
    purpose: purpose(v.purpose),
    expectedEpoch: consentUint64(v.expectedEpoch),
    nonce: consentDigest(v.nonce),
    submitBefore: seconds(v.submitBefore),
  });
}
export function parsePublicationCorrection(value: unknown) {
  const v = fields(value, "PublicationCorrection");
  const result = {
    learner: consentAddress(v.learner),
    communityId: consentDigest(v.communityId),
    purpose: purpose(v.purpose),
    publicationTarget: consentAddress(v.publicationTarget),
    publicationTargetRuntimeHash: consentDigest(v.publicationTargetRuntimeHash),
    permissionRevision: consentUint64(v.permissionRevision),
    policyHash: consentDigest(v.policyHash),
    withdrawalEpoch: consentUint64(v.withdrawalEpoch),
    resultId: consentDigest(v.resultId),
    originalGrantId: consentDigest(v.originalGrantId),
    previousCommitment: consentDigest(v.previousCommitment),
    correctedCommitment: consentDigest(v.correctedCommitment),
    reasonHash: consentDigest(v.reasonHash, true),
    nonce: consentDigest(v.nonce),
    issuedAt: seconds(v.issuedAt),
    submitBefore: seconds(v.submitBefore),
  };
  insist(
    result.permissionRevision > 0n && result.issuedAt < result.submitBefore,
    "invalid_consent_window",
  );
  return Object.freeze(result);
}
export function preparePublicationGrant(
  chainId: bigint,
  registry: Address,
  value: unknown,
  signature: Hex,
) {
  const message = parsePublicationGrant(value);
  const typed = {
    domain: publicationDomain(chainId, registry),
    types: publicationConsentTypes,
    primaryType: "PublicationGrant",
    message,
  } as const;
  return Object.freeze({
    message,
    typed,
    digest: hashTypedData(typed),
    data: encodeFunctionData({
      abi: publicationConsentAbi,
      functionName: "grant",
      args: [message, signature],
    }),
  });
}
export function preparePublicationWithdrawal(
  chainId: bigint,
  registry: Address,
  value: unknown,
  signature: Hex,
) {
  const message = parsePublicationWithdrawal(value);
  const typed = {
    domain: publicationDomain(chainId, registry),
    types: publicationConsentTypes,
    primaryType: "PublicationWithdrawal",
    message,
  } as const;
  return Object.freeze({
    message,
    typed,
    digest: hashTypedData(typed),
    data: encodeFunctionData({
      abi: publicationConsentAbi,
      functionName: "withdraw",
      args: [message, signature],
    }),
  });
}
export function publicationCorrectionDigest(
  chainId: bigint,
  registry: Address,
  value: unknown,
) {
  const message = parsePublicationCorrection(value);
  return hashTypedData({
    domain: publicationDomain(chainId, registry),
    types: publicationConsentTypes,
    primaryType: "PublicationCorrection",
    message,
  });
}
export function publicationPolicy(value: unknown) {
  const v = object(value);
  exact(v, [
    "schema",
    "purpose",
    "termsSha256",
    "disclosureSha256",
    "privacySha256",
    "retentionSha256",
    "maxGrantDurationSeconds",
    "maxSubmissionDelaySeconds",
    "dancePublicityPolicyHash",
  ]);
  insist(
    v.schema === "pirate.publication-policy/1",
    "invalid_publication_policy",
  );
  const p = purpose(v.purpose);
  const maxGrant = consentUint64(v.maxGrantDurationSeconds),
    maxSubmit = consentUint64(v.maxSubmissionDelaySeconds);
  insist(maxGrant > 0n && maxSubmit > 0n, "invalid_policy_duration");
  consentDigest(v.termsSha256);
  consentDigest(v.disclosureSha256);
  consentDigest(v.privacySha256);
  consentDigest(v.retentionSha256);
  const dance = consentDigest(v.dancePublicityPolicyHash, true);
  insist(
    p.startsWith("dance-") ? dance !== zero : dance === zero,
    "wrong_dance_policy_binding",
  );
  const bytes = canonical(v);
  return Object.freeze({
    bytes,
    policyHash: sha256(stringToHex(bytes)),
    purpose: p,
    maxGrantDurationSeconds: maxGrant,
    maxSubmissionDelaySeconds: maxSubmit,
    dancePublicityPolicyHash: dance,
  });
}

// Pure encoders only: no latest-grant lookup, provider, signing or automatic
// dispatch. The caller must preserve the exact prepared digest/raw transaction
// and reconcile the original at a canonical safe block before any new action.

/** Release-time binding check. No descriptor is activated by parsing a document. */
export function verifyPublicationPolicy(
  value: unknown,
  selected: {
    purpose: PublicationPurpose;
    policyHash: Hex;
    maxGrantDurationSeconds: bigint;
    maxSubmissionDelaySeconds: bigint;
    dancePublicityPolicyHash: Hex;
  },
) {
  const p = publicationPolicy(value);
  insist(
    p.purpose === selected.purpose &&
      p.policyHash === selected.policyHash &&
      p.maxGrantDurationSeconds === selected.maxGrantDurationSeconds &&
      p.maxSubmissionDelaySeconds === selected.maxSubmissionDelaySeconds &&
      p.dancePublicityPolicyHash === selected.dancePublicityPolicyHash,
    "publication_policy_binding_mismatch",
  );
  return p;
}
