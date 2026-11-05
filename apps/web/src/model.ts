// Public read interface between the community web client and its sources.
//
// A future community service must serve these shapes under /api/public. A
// mirror serves the same shapes as snapshot files under /public/data, so the
// client reads one model whichever source is current. Nothing here is a
// session, mutation or credential type.

export const PROTOCOL_VERSION = 1;
export const DOCUMENT_VERSION = 1;

export type { CommunityClientConfig as CommunityConfig } from "../../../packages/community/application-api.ts";

export interface PublicAuthor {
  readonly handle: string;
  readonly displayName: string;
}

export interface PostSummary {
  readonly slug: string;
  readonly title: string;
  readonly author: PublicAuthor;
  readonly publishedAt: string;
}

export interface PublicCommunity {
  readonly communityId: string;
  readonly name: string;
  readonly description: string;
  readonly lang: string;
  readonly dir: "ltr" | "rtl";
  readonly revision: number;
  readonly posts: readonly PostSummary[];
  readonly fixture?: true;
}

export interface PublicSong {
  readonly title: string;
  readonly artist: string;
}

export interface PublicPost {
  readonly kind: "post";
  readonly slug: string;
  readonly revision: number;
  readonly title: string;
  readonly body: string;
  readonly lang: string;
  readonly dir: "ltr" | "rtl";
  readonly author: PublicAuthor;
  readonly song?: PublicSong;
  readonly publishedAt: string;
  readonly fixture?: true;
}

/** A removal is itself a content revision and carries no removed content. */
export interface RemovedPost {
  readonly kind: "removed";
  readonly slug: string;
  readonly revision: number;
}

export type PostRecord = PublicPost | RemovedPost;

export const paths = {
  config: "/.well-known/pirate-client.json",
  page: { community: "/", post: (slug: string) => `/posts/${slug}/` },
  api: {
    community: "/api/public/community",
    post: (slug: string) => `/api/public/posts/${encodeURIComponent(slug)}`,
    session: "/api/session",
  },
  snapshot: {
    community: "/public/data/community.json",
    post: (slug: string) => `/public/data/posts/${encodeURIComponent(slug)}.json`,
  },
  documentStylesheet: (version: number) => `/public/document-v${version}.css`,
  boot: "/app/boot.js",
  shell: "/app/shell.html",
  notFound: "/public/not-found.html",
  gone: "/public/gone.html",
} as const;

/** Client-only routes. Every other path without a file is a real 404. */
export const clientRoutes = ["/about"] as const;

const slugPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
export function isSlug(value: string): boolean {
  return slugPattern.test(value);
}
