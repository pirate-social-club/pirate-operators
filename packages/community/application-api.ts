// Dependency-free client wire types. Runtime manifest validation stays here in
// post-manifest.ts; the web package can build and typecheck independently.
export type {
  CommunityClientConfig,
  CreatorConnectionView,
  CommunitySessionView,
  CommunityCapabilities,
  PublicSongView,
  CommunityFeed,
} from "../../apps/web/src/api-contract.ts";
