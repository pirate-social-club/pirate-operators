/** Proposed admission-v5 local implementation. Runtime and final ABI held. */
import type { D1PreparedStatement } from "@cloudflare/workers-types";
export const DANCE_VERSION = "pirate.dance/1" as const;
export const DANCE_SOURCE = "pirate.dance-verdict/1" as const;
export const REVIEW_WINDOW_MS = 604800000;
export const DANCE_PRIVATE_MEDIA_POLICY = Object.freeze({
  version: "pirate.dance-private/1",
  minSamples: 288000,
  maxSamples: 1440000,
});
export type DanceVerdict = "pass" | "not_passed";
export type SqlValue = string | number | null;
/** Trusted SQL fences local intent only, never canonical execution. */
export interface DanceFence {
  sql: string;
  values: SqlValue[];
}
export interface DancePrincipal {
  accountId: string;
  wallet: string;
  active: boolean;
  identityEpoch: number;
  groupId: string;
  groupEpoch: number;
  knownAliases: readonly string[];
  authorizationId: string;
  accountCommitment: string;
}
export interface DanceOwner {
  accountId: string;
  wallet: string;
  assignmentId: string;
  epoch: number;
  expiresAtMs: number;
  canonicalAccepted: boolean;
}
export interface DanceAuthority {
  actor: DancePrincipal;
  learner: DancePrincipal;
  owner: DanceOwner;
  fence: DanceFence;
  epochs: {
    configurationRevision: number;
    rulesEpoch: number;
    mediaEpoch: number;
  };
  reviewer: null | {
    delegationId: string;
    ownerEpoch: number;
    roleEpoch: number;
    expiresAtMs: number;
    canonicalAccepted: boolean;
  };
}
export interface DanceSourcePin {
  chainId: number;
  address: string;
  runtimeCodeHash: string;
  fromBlock: string;
  communityId: string;
  publisher: string;
  policyHash: string;
  sourceHash: string;
}
export interface DanceOfferSelection {
  offerId: string;
  offerIdCommitment: string;
  inputHash: string;
  sourceHash: string;
  opensAtMs: number;
  cutoffAtMs: number;
}
export interface DanceConsentPolicy {
  version: string;
  termsHash: string;
  publicityPolicyHash: string;
  text: string;
  admission: "review_pending" | "admitted";
}
export interface DanceConsentAcceptance {
  accepted: true;
  version: string;
  termsHash: string;
  publicityPolicyHash: string;
}
export interface DanceConsentReceipt extends DanceConsentAcceptance {
  receiptId: string;
  accountId: string;
  captureId: string;
  captureHash: string;
  acceptedAtMs: number;
}
export interface DanceCapture {
  version: typeof DANCE_VERSION;
  captureId: string;
  communityId: string;
  learner: DancePrincipal;
  songKey: string;
  songRevision: number;
  songDurationSamples: number;
  manifestSha256: string;
  audioSha256: string;
  mediaPolicyVersion: string;
  mediaPolicyHash: string;
  reference: null | {
    id: string;
    revision: number;
    epoch: number;
    segmentId: string;
    segmentLayoutSha256: string;
  };
  startSample: number;
  durationSamples: number;
  policy: "moderator-review-policy-v2";
  rulesHash: string;
  termsHash: string;
  rubricHash: string;
  rubricText: string;
  offer: DanceOfferSelection | null;
  source: DanceSourcePin;
  reservedAtMs: number;
  expiresAtMs: number;
  captureHash: string;
  consent: DanceConsentReceipt | null;
  expected: {
    ownerEpoch: number;
    configurationRevision: number;
    rulesEpoch: number;
    mediaEpoch: number;
  };
}
/** Structural source3 interface. No mutable peer runtime import. */
export interface DanceMediaBinding {
  communityId: string;
  accountId: string;
  songKey: string;
  songRevision: number;
  audioSha256: string;
  mediaPolicyVersion: string;
  recordingSha256: string;
  startSample: number;
  durationSamples: number;
}
export interface DanceReadyMedia extends DanceMediaBinding {
  version: "pirate.community-media/1";
  id: string;
  revision: number;
  purpose: "public-feed" | "private-review";
  rendition: Readonly<{
    sha256: string;
    bytes: number;
    durationMs: number;
    width: number;
    height: number;
    videoCodec: "h264";
    audioCodec: "aac";
  }>;
  readyAt: number;
  expiresAt: number;
}
export interface DanceMediaWitness {
  id: string;
  communityId: string;
  accountId: string;
  revision: number;
  recordingSha256: string;
  expiresAt: number;
}
export interface DanceMediaSubmissionReceipt {
  submissionId: string;
  communityId: string;
  accountId: string;
  mediaId: string;
  bindingCommitment: string;
  trustedSubmittedAtMs: number;
  reviewDeadlineMs: number;
  mediaRevision: number;
}
export interface DanceMediaSubmissionPlan {
  beforeAcceptance: D1PreparedStatement[];
  afterAcceptance: D1PreparedStatement[];
}
export interface DanceMediaFacts extends DanceMediaBinding {
  version: "pirate.community-media-dance/1";
  id: string;
  revision: number;
  purpose: "private-review";
  readyAtMs: number;
  expiresAtMs: number;
}
export interface DanceMediaPort {
  version: "pirate.dance-media-port/1";
  readyForSubmission(
    id: string,
    binding: DanceMediaBinding,
    actor: { accountId: string },
  ): Promise<{ media: DanceReadyMedia; witness: DanceMediaWitness }>;
  readyForReview(
    id: string,
    binding: DanceMediaBinding,
    actor: { accountId: string },
  ): Promise<{ media: DanceReadyMedia; witness: DanceMediaWitness }>;
  prepareMediaSubmission(
    witness: DanceMediaWitness,
    submissionId: string,
    bindingCommitment: string,
    accepted: DanceFence,
  ): DanceMediaSubmissionPlan;
  commitFence(witness: DanceMediaWitness): DanceFence;
  projectDanceMedia(
    media: DanceReadyMedia,
    witness: DanceMediaWitness,
  ): DanceMediaFacts;
  projectDanceSubmission(
    media: DanceMediaFacts,
    receipt: DanceMediaSubmissionReceipt,
  ): {
    submissionId: string;
    bindingCommitment: string;
    trustedSubmittedAtMs: number;
    reviewDeadlineMs: number;
  };
}
export type DanceState =
  | "awaiting_review"
  | "decision_pending"
  | "withdrawal_pending"
  | "expired"
  | "canonical";
export interface ReviewerContext {
  accountId: string;
  wallet: string;
  identityEpoch: number;
  groupId: string;
  groupEpoch: number;
  authorizationId: string;
  knownAliases: readonly string[];
  authority: string;
  ownerEpoch: number;
  roleEpoch: number;
  accountCommitment: string;
  expectedConfigurationRevision: number;
  expectedRulesEpoch: number;
  expectedMediaEpoch: number;
  consentVersion: string;
  publicityPolicyHash: string;
  consentAccepted: true;
}
/** One service/store/recovery preimage. Local JSON integrity is NOT ABI/keccak. */
export interface DecisionIntentPreimage {
  version: typeof DANCE_SOURCE;
  operation: "CommitVerdict";
  commandId: string;
  submissionId: string;
  capture: DanceCapture;
  media: DanceMediaBinding;
  mediaId: string;
  mediaGeneration: number;
  mediaBindingHash: string;
  trustedSubmittedAtMs: number;
  reviewDeadlineMs: number;
  reviewer: ReviewerContext;
  verdict: DanceVerdict;
  intentAcceptedAtMs: number;
}
export interface DanceDecisionIntent {
  intentId: string;
  commandId: string;
  preimage: DecisionIntentPreimage;
  localIntegrityHash: string;
}
export interface DanceCanonicalEvidence {
  version: typeof DANCE_SOURCE;
  verification: "coordinator-validated/1";
  commandId: string;
  submissionId: string;
  intentIntegrityHash: string;
  commandHash: string;
  submissionHash: string;
  source: DanceSourcePin;
  verdict: DanceVerdict;
  committedAtSeconds: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  blockNumber: string;
  blockHash: string;
  removed: false;
  finality: "latest" | "safe";
  canonical: boolean;
  evidenceHash: string;
}
export interface DanceReview {
  version: typeof DANCE_VERSION;
  reviewId: string;
  revision: number;
  capture: DanceCapture;
  media: DanceMediaBinding;
  receipt: DanceMediaSubmissionReceipt;
  state: DanceState;
  localDenied: boolean;
  decision: DanceDecisionIntent | null;
  canonical: DanceCanonicalEvidence | null;
}
export interface DanceReceipt {
  version: typeof DANCE_VERSION;
  commandId: string;
  reviewId: string;
  revision: number;
  state: DanceState;
  intentId: string | null;
}
export interface DanceQueue {
  version: typeof DANCE_VERSION;
  items: DanceReview[];
  cursor: string | null;
  skipped: { count: number; reasons: Record<string, number> };
}
export interface DanceControlIntent {
  version: "pirate.dance-control-intent/1";
  commandId: string;
  communityId: string;
  actorId: string;
  delegationId: string;
  accountId: string;
  wallet: string;
  operation: "grant" | "revoke";
  ownerAssignment: string;
  ownerEpoch: number;
  expectedConfigurationRevision: number;
  expectedReviewerEpoch: number;
  expiresAtMs: number;
  localIntegrityHash: string;
  status: "pending_canonical";
}
export interface DanceStoredGrant {
  delegationId: string;
  communityId: string;
  accountId: string;
  wallet: string;
  ownerAssignment: string;
}
export interface DanceOutbox {
  commandId: string;
  communityId: string;
  subjectId: string;
  kind: "submission" | "decision" | "withdraw" | "grant" | "revoke";
  payloadJson: string;
  localIntegrityHash: string;
  status:
    | "held"
    | "ready"
    | "unknown"
    | "latest"
    | "safe"
    | "orphaned"
    | "canceled";
}
export interface DanceAttempt {
  attemptId: string;
  commandId: string;
  nonce: string;
  rawTransaction: string;
  transactionHash: string;
}
export interface DanceSelection {
  songKey: string;
  offerId: string | null;
  referenceId: string | null;
}
export interface DancePorts {
  authority(
    communityId: string,
    actorId: string,
    learnerId: string,
  ): Promise<DanceAuthority>;
  admitCapture(
    communityId: string,
    actorId: string,
    selection: DanceSelection,
  ): Promise<{
    capture: Omit<
      DanceCapture,
      "captureId" | "consent" | "reservedAtMs" | "captureHash"
    >;
    consentPolicy: DanceConsentPolicy;
    fence: DanceFence;
  }>;
  media: DanceMediaPort;
  rules(capture: DanceCapture): Promise<DanceFence>;
  /** Recheck EXACT captured V4 authorization, not a later session substitute. */
  authorization(capture: DanceCapture): Promise<DanceFence>;
  /** Coordinator-supplied proposed binding; final ABI/hash fixture remains held. */
  captureCommitment(
    capture: Omit<DanceCapture, "captureHash" | "consent">,
  ): Promise<string>;
  mediaBindingHash(preimage: {
    source: DanceSourcePin;
    captureHash: string;
    mediaId: string;
    expectedPostRetentionGeneration: number;
    recordingSha256: string;
  }): Promise<string>;
  reviewerRoleEpoch(wallet: string): Promise<number>;
  reviewerAuthorization(
    context: ReviewerContext,
    intentAcceptedAtMs: number,
  ): Promise<DanceFence>;
  offerIdCommitment(
    originalAsciiOfferId: string,
    source: DanceSourcePin,
  ): Promise<string>;
  reviewerConsent: {
    version: string;
    publicityPolicyHash: string;
    admission: "review_pending" | "admitted";
  };
  canonicalEvidence(
    intent: DanceDecisionIntent,
  ): Promise<DanceCanonicalEvidence | null>;
}
