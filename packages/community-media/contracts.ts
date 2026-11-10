/** Community media v1. All times are integer Unix milliseconds. */
export const MEDIA_VERSION = "pirate.community-media/1" as const;
export type MediaPurpose = "public-feed" | "private-review";
export type MediaState =
  | "uploading"
  | "receiving"
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "withdrawn"
  | "revoked"
  | "expired";
export interface MediaActor {
  accountId: string;
}
export interface PublishedMediaSong {
  communityId: string;
  songKey: string;
  songRevision: number;
  audioSha256: string;
  /** Server-probed canonical sample count at 48 kHz. */
  durationSamples: number;
  title: string;
}
export interface MediaBinding {
  communityId: string;
  accountId: string;
  songKey: string;
  songRevision: number;
  audioSha256: string;
  recordingSha256: string;
  startSample: number;
  durationSamples: number;
  mediaPolicyVersion: string;
}
export interface MediaDurationPolicy {
  version: string;
  minSamples: number;
  maxSamples: number;
}
export interface MediaIntent {
  requestId: string;
  songKey: string;
  songRevision: number;
  recordingSha256: string;
  bytes: number;
  startSample: number;
  durationSamples: number;
  purpose: MediaPurpose;
  publicConsent: boolean;
}
export interface RenditionFacts {
  sha256: string;
  bytes: number;
  durationMs: number;
  width: number;
  height: number;
  videoCodec: "h264";
  audioCodec: "aac";
}
export interface MediaRecord extends MediaBinding {
  version: typeof MEDIA_VERSION;
  id: string;
  requestId: string;
  revision: number;
  state: MediaState;
  purpose: MediaPurpose;
  publicConsent: boolean;
  sourceBytes: number;
  createdAt: number;
  uploadExpiresAt: number;
  expiresAt: number;
  attempts: number;
  claim?: string;
  leaseUntil?: number;
  sourceKey?: string;
  renditionKey?: string;
  rendition?: RenditionFacts;
  readyAt?: number;
  error?: string;
  erasePending?: boolean;
  submissionId?: string;
  submissionBindingCommitment?: string;
  trustedSubmittedAtMs?: number;
  reviewDeadlineMs?: number;
}
export interface ReadyMedia extends MediaBinding {
  version: typeof MEDIA_VERSION;
  id: string;
  revision: number;
  purpose: MediaPurpose;
  rendition: Readonly<RenditionFacts>;
  readyAt: number;
  expiresAt: number;
  submissionId?: string;
  trustedSubmittedAtMs?: number;
  reviewDeadlineMs?: number;
}
/** Not a bearer capability. Fences the D1 pending intent only, never final chain ordering. */
export interface MediaReviewWitness {
  id: string;
  communityId: string;
  accountId: string;
  revision: number;
  recordingSha256: string;
  expiresAt: number;
}
export type MediaSubmissionWitness = MediaReviewWitness;
export interface MediaSubmissionReceipt {
  submissionId: string;
  communityId: string;
  accountId: string;
  mediaId: string;
  bindingCommitment: string;
  trustedSubmittedAtMs: number;
  reviewDeadlineMs: number;
  mediaRevision: number;
}
export interface MediaCapability {
  allowed: boolean;
  reason: string;
}
export const PUBLIC_POSTING_UNDECIDED: MediaCapability = Object.freeze({
  allowed: false,
  reason: "owner_decision_pending",
});
export interface MediaQuota {
  perAccount: number;
  perCommunity: number;
  bytesPerCommunity: number;
}
export interface MediaStatus {
  id: string;
  state: MediaState;
  purpose: MediaPurpose;
  error?: string;
  canRetry: boolean;
  expiresAt: number;
  playbackUrl?: string;
  ready?: ReadyMedia;
}
export interface MediaFeedItem {
  id: string;
  songKey: string;
  songRevision: number;
  title: string;
  readyAt: number;
  playbackUrl: string;
  durationMs: number;
}
export interface MediaFeedPage {
  version: typeof MEDIA_VERSION;
  items: MediaFeedItem[];
  cursor: string | null;
}
export interface MediaProcessor {
  /** Must verify canonical song audio digest and probe source/output bytes. */
  render(
    source: Uint8Array,
    media: MediaRecord,
    song: PublishedMediaSong,
  ): Promise<{
    bytes: Uint8Array;
    facts: RenditionFacts;
  }>;
}
