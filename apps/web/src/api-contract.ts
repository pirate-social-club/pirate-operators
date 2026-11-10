/** Client bootstrap is separate from the directory's canonical contract manifest. */
export interface CommunityClientConfig {
  readonly schema: "pirate.community-client-config/1";
  readonly communityId: string;
  readonly canonicalOrigin: string;
  readonly apiBase: "/api";
  readonly protocolVersions: readonly number[];
  readonly defaultLanguage: string;
  readonly supportedLanguages: readonly string[];
  readonly mirrors: readonly string[];
  readonly signature?: never;
  readonly fixture?: true;
}
export interface CreatorConnectionView {
  connectionId: string;
  state: string | null;
  requestId: string | null;
  expiresAt: number;
}
export interface CommunitySessionView {
  authenticated: true;
  authorId: string;
  mossAddress: string;
  csrf: string;
  /** Preserved for the deferred creator connection; the launch client ignores it. */
  creator: { evmAddress: string; verifiedAt: number } | null;
  /** Preserved for the deferred creator connection; the launch client ignores it. */
  pendingConnection: CreatorConnectionView | null;
  /** Whether this account's sign-in authorizes public Study and Karaoke results. */
  publicResults: "on" | "pending" | "off" | "unavailable";
  /** Whether this account sees release controls. Display only: the release
   * API enforces the owner authorization on every write. */
  publisher: boolean;
}
export interface CommunityCapabilities {
  rewards?: boolean;
  study?: boolean;
  learningServiceMode?: "internal";
  /**
   * The learning documents of the community's version (3 or 4), linked from
   * normal site navigation. A V4 sign-in accepts them, so the sign-in screen
   * also links them in a V4 community.
   */
  learningPolicy?: { version: 3 | 4; termsUrl: string; privacyUrl: string };
  schema: "pirate.community-capabilities/1";
  signIn: boolean;
  /** Preserved for the deferred creator connection; false under owner publishing. */
  creatorConnection: boolean;
  upload: boolean;
  publication: boolean;
  policyVersion: string;
}
export interface PublicSongView {
  /** Public fields used by this client. The server validates the complete
   * canonical post manifest before exposing this projection. */
  manifest: {
    schema:
      | "pirate.community-post/1"
      | "pirate.community-post/2"
      | "pirate.community-post/3";
    postId: string;
    authorId: string;
    title: string;
    language: string;
    rating: "general" | "adult";
    declarationSource?: "operator_declared";
    automatedContent?: "deferred";
  };
  audioUrl: string;
  postUrl: string;
  transactionHash: string;
  lyricsText?: string;
}
export interface CommunityFeed {
  schema: "pirate.community-feed/1";
  communityId: string;
  posts: PublicSongView[];
}
export interface CommunityUploadView {
  submissionId: string;
  postId: string;
  title: string;
  state: string;
  jobId: string | null;
}
export interface CommunityJobView {
  schema: "pirate.publication-job-view/1";
  jobId: string;
  submissionId: string;
  postId: string;
  phase: string;
  errorCode: string | null;
  resumable: boolean;
}

/** Private operator presentation; public chain outcomes use their own protocol. */
export interface KaraokeLineFeedback {
  lineId: string;
  scoredLineIndex: number;
  score: number;
  uncertain: boolean;
}
export interface KaraokeOperatorResult {
  status: "completed" | "abandoned" | "expired" | "payment_missing";
  summary: { scoreBps: number };
  lines: readonly { status: string; scoreBps: number | null }[];
  unmeasuredCount: number;
  presentation?: {
    finalScore: number;
    lyricsScore: number;
    timingScore: number | null;
    timingTrend: "early" | "late" | "mixed" | "on_time";
    scoredLineCount: number;
    uncertainLineCount: number;
    bestCombo: number;
  };
}
