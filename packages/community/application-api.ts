import type { PostManifest } from "./post-manifest.ts";

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
  creator: { evmAddress: string; verifiedAt: number } | null;
  pendingConnection: CreatorConnectionView | null;
}
export interface CommunityCapabilities {
  schema: "pirate.community-capabilities/1";
  signIn: boolean;
  creatorConnection: boolean;
  upload: boolean;
  publication: boolean;
  policyVersion: string;
}
export interface PublicSongView {
  manifest: PostManifest;
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
