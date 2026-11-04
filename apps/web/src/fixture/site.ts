// FIXTURE DATA. This community, its posts and the removed post are invented
// for local acceptance. They are not a real community, real people or a real
// service response. Every record carries `fixture: true` so the client can
// label them, and the canonical origin is a loopback address.
import type { CommunityConfig, PostRecord, PublicCommunity, PublicPost } from "../model.ts";

export const FIXTURE_CANONICAL_ORIGIN = "http://localhost:4173";

export const fixtureConfig: CommunityConfig = {
  schema: "pirate.community-config/1",
  communityId: "fixture-community",
  canonicalOrigin: FIXTURE_CANONICAL_ORIGIN,
  apiBase: "/api",
  protocolVersions: [1],
  defaultLanguage: "en",
  supportedLanguages: ["en", "ar"],
  mirrors: [],
  fixture: true,
};

const author = { handle: "fixture-singer", displayName: "Fixture Singer" };

export const fixturePost: PublicPost = {
  kind: "post",
  slug: "first-song",
  revision: 1,
  title: "A first song for the fixture community",
  body: "This post exists only to test publication-time HTML, mirrors and the static client.",
  lang: "en",
  dir: "ltr",
  author,
  song: { title: "Fixture Melody", artist: "Fixture Singer" },
  publishedAt: "2026-11-04T00:00:00.000Z",
  fixture: true,
};

export const fixtureArabicPost: PublicPost = {
  kind: "post",
  slug: "arabic-note",
  revision: 1,
  title: "ملاحظة تجريبية",
  body: "هذا منشور تجريبي لاختبار اتجاه النص من اليمين إلى اليسار.",
  lang: "ar",
  dir: "rtl",
  author,
  publishedAt: "2026-11-04T00:00:00.000Z",
  fixture: true,
};

export const fixtureRemoved: PostRecord = { kind: "removed", slug: "withdrawn-post", revision: 2 };

export const fixtureCommunity: PublicCommunity = {
  communityId: fixtureConfig.communityId,
  name: "Fixture Community",
  description: "A local test community. Its content is fixture data.",
  lang: "en",
  dir: "ltr",
  revision: 1,
  posts: [fixturePost, fixtureArabicPost].map(post => ({
    slug: post.slug,
    title: post.title,
    author: post.author,
    publishedAt: post.publishedAt,
  })),
  fixture: true,
};

export const fixturePosts: readonly PostRecord[] = [fixturePost, fixtureArabicPost, fixtureRemoved];

/** Publication time recorded in pages; fixed so rebuilds are byte-identical. */
export const FIXTURE_GENERATED_AT = "2026-11-04T00:00:00.000Z";
