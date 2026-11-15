import { bytes32, canonical, exact, hashJson, insist, integer, object, text } from "../community/common.ts";
import { address, httpsOrigin } from "../community/manifest-core.ts";

/** Public trust input. No provider project, bucket, key or moderation identity. */
export interface RecognitionProfile {
  schema: "pirate.recognition-profile/1";
  namespace: string;
  origin: string;
  signer: string;
  providerBindingSha256: string;
  sha256: string;
}
export function recognitionProfile(input: unknown): RecognitionProfile {
  const v = object(input);
  exact(v, ["schema", "namespace", "origin", "signer", "providerBindingSha256", "sha256"]);
  insist(v.schema === "pirate.recognition-profile/1", "recognition_profile_invalid");
  const payload = { schema: "pirate.recognition-profile/1" as const,
    namespace: bytes32(v.namespace), origin: httpsOrigin(v.origin), signer: address(v.signer),
    providerBindingSha256: bytes32(v.providerBindingSha256) };
  insist(hashJson(payload) === v.sha256, "recognition_profile_hash_changed");
  return Object.freeze({ ...payload, sha256: bytes32(v.sha256) });
}

/** Fresh canonical owner admission, NOT a published post or catalog-status proof. */
export interface AcceptedIntent {
  schema: "pirate.recognition-accepted-intent/1";
  namespace: string;
  profileSha256: string;
  communityId: string;
  communityOrigin: string;
  configurationRevision: number;
  jobId: string;
  submissionId: string;
  inputHash: string;
  authoritySha256: string;
  ownerAuthorizationSha256: string;
  creatorKey: string;
  postId: string;
  publicationRevision: number;
  audioSha256: string;
  audioBytes: number;
  audioObjectKey: string;
  audioRevision: number;
  audioEtag: string;
  metadataSha256: string;
  termsRevision: number;
  termsSha256: string;
  allowsDerivatives: boolean;
  acceptedAt: number;
}
export function acceptedIntent(value: unknown): AcceptedIntent {
  const v = object(value);
  exact(v, ["schema", "namespace", "profileSha256", "communityId", "communityOrigin", "configurationRevision",
    "jobId", "submissionId", "inputHash", "authoritySha256", "ownerAuthorizationSha256", "creatorKey",
    "postId", "publicationRevision", "audioSha256", "audioBytes", "audioObjectKey", "audioRevision", "audioEtag",
    "metadataSha256", "termsRevision", "termsSha256", "allowsDerivatives", "acceptedAt"]);
  insist(v.schema === "pirate.recognition-accepted-intent/1" &&
    typeof v.creatorKey === "string" && /^eip155:6343:0x[0-9a-f]{40}$/.test(v.creatorKey) &&
    !v.creatorKey.endsWith("0".repeat(40)) && typeof v.allowsDerivatives === "boolean", "recognition_intent_invalid");
  const key = text(v.audioObjectKey, 1024);
  insist(!key.includes("://") && !key.includes("..") && key.startsWith("staging/"), "recognition_private_media_required");
  const jobId = text(v.jobId, 128), submissionId = text(v.submissionId, 128);
  insist(jobId === `publication:${submissionId}`, "recognition_intent_job_mismatch");
  return Object.freeze({ schema: "pirate.recognition-accepted-intent/1", namespace: bytes32(v.namespace),
    profileSha256: bytes32(v.profileSha256), communityId: bytes32(v.communityId), communityOrigin: httpsOrigin(v.communityOrigin),
    configurationRevision: integer(v.configurationRevision, 1, 2147483647), jobId, submissionId,
    inputHash: bytes32(v.inputHash), authoritySha256: bytes32(v.authoritySha256),
    ownerAuthorizationSha256: bytes32(v.ownerAuthorizationSha256), creatorKey: v.creatorKey,
    postId: bytes32(v.postId), publicationRevision: integer(v.publicationRevision, 1, 2147483647),
    audioSha256: bytes32(v.audioSha256), audioBytes: integer(v.audioBytes, 1, 25 * 1024 * 1024),
    audioObjectKey: key, audioRevision: integer(v.audioRevision, 1, 2147483647), audioEtag: text(v.audioEtag, 256),
    metadataSha256: bytes32(v.metadataSha256), termsRevision: integer(v.termsRevision, 1, 2147483647),
    termsSha256: bytes32(v.termsSha256), allowsDerivatives: v.allowsDerivatives,
    acceptedAt: integer(v.acceptedAt, 0, Number.MAX_SAFE_INTEGER) });
}
export const reservationId = (p: AcceptedIntent) => hashJson({ purpose: "recognition-reservation/1", namespace: p.namespace,
  communityId: p.communityId, jobId: p.jobId, inputHash: p.inputHash });
export const sameIntent = (a: AcceptedIntent, b: AcceptedIntent) => canonical(a) === canonical(b);

/** Extracted from the already durable prepared operation; never a replacement signing request. */
export interface PostingBinding {
  operationId: string;
  requestHash: string;
  signedTransaction: `0x${string}`;
  transactionHash: `0x${string}`;
  nonce: number;
}
