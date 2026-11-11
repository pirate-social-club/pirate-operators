// Queued source assertions. The correction actor does not execute checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommunityFeed } from "../src/api-contract.ts";
import { communityChrome } from "../src/shell/chrome-adapter.ts";
import {
  projectSongPosts,
  songLibrary,
} from "../src/shell/decentralized-adapter.ts";

const feed = {
  schema: "pirate.community-feed/1",
  communityId: "community-a",
  posts: ["a", "b", "c"].map((postId) => ({
    manifest: {
      schema: "pirate.community-post/3",
      postId,
      authorId: "publisher-id",
      title: `Song ${postId}`,
      language: "en",
      rating: "general",
    },
    audioUrl: `/audio/${postId}`,
    postUrl: `/posts/${postId}`,
    transactionHash: "receipt",
    lyricsText: "Published lyrics",
  })),
} as CommunityFeed;
const input = {
  feed,
  communityId: "community-a",
  account: "0xAbC",
  currentUrl: new URL(
    "https://community.example/?language=en&lesson=old#/songs",
  ),
  study: true,
};
const progress = {
  communityId: "community-a",
  account: "0xabc",
  rows: [
    { postId: "a", currentStreak: 2 },
    { postId: "b", currentStreak: 0 },
    { postId: "c", currentStreak: 4 },
  ],
};

test("only a complete account/community-bound projection supplies streaks", () => {
  const collection = songLibrary({ ...input, progress });
  assert.equal(collection.state, "ready");
  assert.deepEqual(
    collection.active.map((song) => [song.id, song.currentStreak]),
    [
      ["c", 4],
      ["a", 2],
    ],
  );
  assert.deepEqual(
    collection.remaining.map((song) => song.id),
    ["b"],
  );
  assert.equal(
    new URL(collection.active[0]!.studyPath!).searchParams.get("study"),
    "c",
  );
  assert.equal(
    new URL(collection.active[0]!.studyPath!).searchParams.has("lesson"),
    false,
  );
  assert.equal(
    new URL(collection.active[0]!.studyPath!).searchParams.get("language"),
    "en",
  );
});

test("missing, stale, partial and invalid streak facts never become zero-day histories", () => {
  for (const invalid of [
    undefined,
    { ...progress, communityId: "elsewhere" },
    { ...progress, account: "different-account" },
    { ...progress, rows: progress.rows.slice(1) },
    { ...progress, rows: [...progress.rows, progress.rows[0]!] },
    {
      ...progress,
      rows: progress.rows.map((row) => ({ ...row, currentStreak: -1 })),
    },
    {
      ...progress,
      rows: progress.rows.map((row) => ({ ...row, currentStreak: 1.5 })),
    },
  ]) {
    const collection = songLibrary({ ...input, progress: invalid });
    assert.equal(collection.state, "not-yet-available");
    assert.deepEqual(collection.active, []);
    assert.equal(collection.remaining.length, 3);
    assert.ok(
      collection.remaining.every((song) => song.currentStreak === undefined),
    );
  }
  assert.equal(
    songLibrary({ ...input, account: undefined, progress }).state,
    "not-yet-available",
  );
});

test("published songs preserve server order and do not invent social/timing facts", () => {
  const posts = projectSongPosts(feed);
  assert.deepEqual(
    posts.map((post) => post.id),
    ["a", "b", "c"],
  );
  assert.ok(posts.every((post) => post.technicalAuthorId === "publisher-id"));
  assert.ok(
    posts.every(
      (post) =>
        post.authorHandle === undefined && post.authorAvatarSrc === undefined,
    ),
  );
  assert.ok(posts.every((post) => post.body === ""));
  assert.ok(
    posts.every(
      (post) => post.publishedAt === undefined && post.authorHref === undefined,
    ),
  );
  assert.ok(
    songLibrary({ ...input, study: false }).remaining.every(
      (song) => !song.studyPath && song.activities?.join() === "karaoke",
    ),
  );
});

test("only an unambiguous bound public projection supplies an author display identity", () => {
  const authors = {
    communityId: "community-a",
    rows: [
      {
        authorId: "publisher-id",
        publicHandle: "public-fixture-handle",
        avatarRef: "/profile/avatar",
        profileHref: "/u/public-fixture-handle",
      },
    ],
  };
  const known = projectSongPosts(feed, authors);
  assert.equal(known[0]!.authorHandle, "public-fixture-handle");
  assert.equal(known[0]!.authorAvatarSrc, "/profile/avatar");
  assert.equal(known[0]!.technicalAuthorId, "publisher-id");
  for (const unavailable of [
    { ...authors, communityId: "different-community" },
    { ...authors, rows: [...authors.rows, authors.rows[0]!] },
    {
      ...authors,
      rows: [{ authorId: "unrelated-author", displayName: "Fixture profile" }],
    },
  ]) {
    const unknown = projectSongPosts(feed, unavailable);
    assert.equal(unknown[0]!.authorHandle, undefined);
    assert.equal(unknown[0]!.authorHref, undefined);
  }
});

test("community and post chrome retain their own mobile header policy", () => {
  const home = communityChrome("home", "/", false, "community-a");
  assert.equal(home.mode, "standard");
  assert.equal(home.hideMobileHeader, true);
  assert.notEqual(home.hideMobileFooter, true);
  const detail = communityChrome("song", "/", false, "community-a");
  assert.equal(detail.hideMobileHeader, true);
  assert.equal(detail.hideMobileFooter, true);
  assert.equal(detail.activeItemId, "none");
  assert.equal(
    communityChrome("songs", "/", false, "community-a").mobileTitle,
    "Your songs",
  );
  assert.equal(
    communityChrome("settings", "/", false, "community-a").activeItemId,
    "settings",
  );
});

test("activity/verification/operator takeover routes never inherit app navigation", () => {
  assert.equal(communityChrome("home", "/", true, "community-a").mode, "bare");
  assert.equal(
    communityChrome("home", "/verify", false, "community-a").mode,
    "bare",
  );
  assert.equal(
    communityChrome("home", "/operator", false, "community-a").mode,
    "bare",
  );
  assert.equal(
    communityChrome("home", "/wallet", false, "community-a").activeItemId,
    "wallet",
  );
});
