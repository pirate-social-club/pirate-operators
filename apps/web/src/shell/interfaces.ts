import type { JSX } from "@solidjs/web";
import type { CommunityFeed, CommunitySessionView } from "../api-contract.ts";

/** Mount contract v1. Renderers own their requests, errors and permission checks. */
export interface ShellFeatureContext {
  version: 1;
  communityId: string;
  session: CommunitySessionView | null;
  songs: Readonly<CommunityFeed["posts"]>;
}
export interface ShellIntegrations {
  version: 1;
  publicFeed?: (context: ShellFeatureContext) => JSX.Element;
  publicPosting?: "unresolved" | "unavailable" | "allowed";
  publicComposer?: (context: ShellFeatureContext) => JSX.Element;
  privateDance?: (context: ShellFeatureContext) => JSX.Element;
  accountSettings?: (context: ShellFeatureContext) => JSX.Element;
}
