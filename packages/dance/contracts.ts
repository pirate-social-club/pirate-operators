/** Owned decentralized categorical review contract. No centralized runtime. */
export const DANCE_VERSION = "pirate.dance/1" as const;
export const DANCE_SOURCE = "pirate.dance-categorical/1" as const;
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Pass as lane3's privateReviewPolicy; public clip policy remains independent. */
export const DANCE_PRIVATE_MEDIA_POLICY = Object.freeze({
  version: "pirate.dance-private/1",
  minSamples: 6 * 48000,
  maxSamples: 30 * 48000,
});
export type SqlValue = string | number | null;
/** Trusted adapter SQL only, never request input. Must observe live rows in DB. */
export interface DanceFence {
  sql: string;
  values: SqlValue[];
}
export interface DancePrincipal {
  accountId: string;
  identityId: string;
  wallet: string;
  active: boolean;
  revision: number;
}
export interface DanceOwner {
  accountId: string;
  identityId: string;
  assignmentId: string;
}
export interface DanceAuthority {
  actor: DancePrincipal;
  learner: DancePrincipal;
  owner: DanceOwner;
  fence: DanceFence;
}
export interface DanceOfferSelection {
  offerId: string;
  inputHash: string;
  sourceId: string;
  opensAtMs: number;
  cutoffAtMs: number;
}
export interface DanceCapture {
  version: typeof DANCE_VERSION;
  captureId: string;
  communityId: string;
  accountId: string;
  identityId: string;
  accountRevision: number;
  wallet: string;
  songKey: string;
  songRevision: number;
  audioSha256: string;
  mediaPolicyVersion: string;
  reference: { id: string; revision: number; segmentId: string } | null;
  startSample: number;
  durationSamples: number;
  policy: "moderator-review-policy-v2";
  rulesHash: string;
  termsHash: string;
  rubricHash: string;
  offer: DanceOfferSelection | null;
  expiresAtMs: number;
}
/** Structurally consumes lane3's MediaBinding, without duplicating its pipeline. */
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
  id: string;
  revision: number;
  purpose: "private-review";
  uploadedAtMs: number;
  expiresAtMs: number;
  fence: DanceFence;
}
export interface DanceOfferFacts {
  /** False is valid: approval is still visible without an eligible reward. */
  admitted: boolean;
  open: boolean;
  inputHash: string;
  sourceId: string;
  fence: DanceFence;
}
export interface DancePorts {
  /** Authenticated account identity is supplied separately, never from JSON. */
  authority(
    communityId: string,
    actorId: string,
    learnerId: string,
  ): Promise<DanceAuthority>;
  /** Current published song/reference/rules and prospective offer admission. */
  admitCapture(
    communityId: string,
    actorId: string,
    selection: {
      songKey: string;
      offerId: string | null;
      referenceId: string | null;
    },
  ): Promise<{ capture: Omit<DanceCapture, "captureId">; fence: DanceFence }>;
  media(
    mediaId: string,
    expected: Omit<DanceMediaBinding, "recordingSha256">,
    actorId: string,
  ): Promise<DanceReadyMedia>;
  /** Rechecks current song, audio, reference, rules and account authorization. */
  rules(capture: DanceCapture): Promise<DanceFence>;
  offer(capture: DanceCapture): Promise<DanceOfferFacts | null>;
}
export type DanceState = "pending" | "reviewed" | "withdrawn" | "expired";
export type DanceRewardReason =
  | "candidate_held"
  | "practice"
  | "not_passed"
  | "source_not_admitted"
  | "offer_closed"
  | "outside_window";
export interface DanceVerdict {
  version: typeof DANCE_SOURCE;
  verdict: "passed" | "not_passed";
  reviewerAccountId: string;
  reviewerIdentityId: string;
  authority: string;
  committedAtMs: number;
  cue: "not_required";
  score: null;
  rewardReason: DanceRewardReason;
  /** Local candidate only. Coordinator chain admission is a separate gate. */
  chainAdmission: "held";
}
export interface DanceReview {
  version: typeof DANCE_VERSION;
  reviewId: string;
  revision: number;
  capture: DanceCapture;
  mediaId: string;
  mediaRevision: number;
  recordingSha256: string;
  uploadedAtMs: number;
  submittedAtMs: number;
  reviewDeadlineMs: number;
  state: DanceState;
  verdict: DanceVerdict | null;
}
export interface DanceReceipt {
  version: typeof DANCE_VERSION;
  commandId: string;
  reviewId: string;
  revision: number;
  state: DanceState;
  verdict: DanceVerdict | null;
}
export interface DanceQueue {
  version: typeof DANCE_VERSION;
  items: DanceReview[];
  cursor: string | null;
}
