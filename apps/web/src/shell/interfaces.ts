import type { JSX } from "@solidjs/web";
import type { CommunityFeed, CommunitySessionView } from "../api-contract.ts";
import type { ProfileActivityDependencies } from "./reference/profile-activity.tsx";

/** Mount contract v1. Renderers own their requests, errors and permission checks. */
export interface ShellFeatureContext {
  version: 1;
  communityId: string;
  session: CommunitySessionView | null;
  songs: Readonly<CommunityFeed["posts"]>;
}
export interface ShellDanceNavigation {
  postHref(postId: string): string;
  open(href: string): void;
}
export interface ShellCommunityMembership {
  /** Only an accepted observational Join readback may set this. */
  readonly joined: boolean;
  readonly checking: boolean;
  readonly unknown: boolean;
  readonly blocked: boolean;
  readonly label: string;
  readonly notice?: string;
  readonly canChooseName: boolean;
  join(): void;
  chooseName(): void;
}
export interface ShellIntegrations {
  version: 1;
  communityMembership?: ShellCommunityMembership;
  /** Normal song action, not a declaration of recording readiness. */
  danceNavigation?: ShellDanceNavigation;
  publicFeed?: (context: ShellFeatureContext) => JSX.Element;
  publicPosting?: "unresolved" | "unavailable" | "allowed";
  publicComposer?: (context: ShellFeatureContext) => JSX.Element;
  privateDance?: (context: ShellFeatureContext) => JSX.Element;
  accountSettings?: (context: ShellFeatureContext) => JSX.Element;
  /** Public identities projected by a real community producer. Opaque author
   * commitments remain lookup keys and never become names or handles. */
  postAuthors?: {
    readonly communityId: string;
    readonly rows: readonly {
      readonly authorId: string;
      readonly publicHandle?: string;
      readonly displayName?: string;
      readonly avatarRef?: string;
      readonly profileHref?: string;
    }[];
  };
  /** Optional authoritative projections. The shell never derives profile or
   * streak facts from a wallet balance, an offer or a recently opened song. */
  profile?: {
    readonly communityId: string;
    readonly account: string;
    readonly name: string;
    readonly handle?: string;
    readonly avatarRef?: string;
    readonly coverRef?: string;
    readonly bio?: string;
    readonly activity?: (context: ShellFeatureContext) => JSX.Element;
    readonly activitySource?: ProfileActivityDependencies;
  };
  songProgress?: {
    readonly communityId: string;
    readonly account: string;
    readonly rows: readonly { postId: string; currentStreak: number }[];
  };
  /** One server-authoritative draw projection supplied by the payment lane.
   * This is rendered once at page level, never once per song. */
  drawSummary?: (context: ShellFeatureContext) => JSX.Element;
}
