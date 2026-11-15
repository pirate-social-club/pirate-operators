import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityRoute,
  activityUrl,
  appView,
  withoutActivity,
  danceRoute,
  danceUrl,
} from "../src/shell/routing.ts";

test("native fragment views preserve song permalinks and refuse unknown destinations", () => {
  for (const hash of ["", "#/"]) assert.equal(appView(hash), "home");
  assert.equal(appView("#song-0x123"), "song");
  for (const view of ["songs", "account", "settings", "publish"] as const)
    assert.equal(appView(`#/${view}`), view);
  for (const hash of [
    "#account",
    "#/wallet",
    "#/songs/unknown",
    "#app-content",
  ])
    assert.equal(appView(hash), "missing");
});

test("conflicting, empty and duplicate activity selectors never choose a lesson", () => {
  for (const search of [
    "?study=",
    "?sing=",
    "?study=a&sing=b",
    "?sing=a&sing=b",
    "?study=a&study=a",
  ])
    assert.deepEqual(
      activityRoute(new URL(`https://community.example/${search}`)),
      { kind: "invalid" },
    );
  assert.deepEqual(
    activityRoute(new URL("https://community.example/?lesson=old#/songs")),
    { kind: "none" },
  );
});

test("Study retains the same lesson on refresh, but a different song drops the binding", () => {
  const current = new URL(
    "https://community.example/?study=song-a&lesson=lesson-a&language=en#/songs",
  );
  assert.equal(activityUrl(current, "study", "song-a").href, current.href);
  const next = activityUrl(current, "study", "song-b");
  assert.deepEqual(activityRoute(next), { kind: "study", postId: "song-b" });
  assert.equal(next.searchParams.has("lesson"), false);
  assert.equal(next.searchParams.get("language"), "en");
  assert.equal(next.hash, "#/songs");
  assert.equal(current.searchParams.get("lesson"), "lesson-a");
});

test("Karaoke replaces Study without borrowing its lesson and survives a URL round trip", () => {
  const next = activityUrl(
    new URL("https://community.example/?study=old&lesson=old&learner=8#/"),
    "sing",
    "song / λ",
  );
  assert.deepEqual(activityRoute(new URL(next.href)), {
    kind: "sing",
    postId: "song / λ",
  });
  assert.equal(next.searchParams.has("study"), false);
  assert.equal(next.searchParams.has("lesson"), false);
  assert.equal(next.searchParams.get("learner"), "8");
});

test("exiting clears only practice identity, preserving other query state and current view", () => {
  const current = new URL(
    "https://community.example/?sing=song&study=old&lesson=old&learner=8#/songs",
  );
  assert.equal(
    withoutActivity(current).href,
    "https://community.example/?learner=8#/songs",
  );
  assert.equal(current.searchParams.get("sing"), "song");
});

test("Study links carry one explicit lesson identity and refuse ambiguous private selectors", () => {
  assert.deepEqual(
    activityRoute(
      new URL("https://community.example/?study=song-a&lesson=lesson-a"),
    ),
    { kind: "study", postId: "song-a", lessonId: "lesson-a" },
  );
  for (const query of [
    "lesson=",
    "lesson=a&lesson=b",
    "lesson=a&lesson=a",
    "lesson=%00a",
    "lesson=%0aa",
    `lesson=${"a".repeat(1025)}`,
  ])
    assert.deepEqual(
      activityRoute(
        new URL(`https://community.example/?study=song-a&${query}`),
      ),
      { kind: "invalid" },
    );
});

test("Dance strict post/song/recording/result routes round-trip the opaque selected community", () => {
  const community = "selected namespace/opaque value", id = "0x" + "a".repeat(64);
  const current = new URL("https://community.example/?filter=a%20b&learner=8#/songs");
  for (const route of [
    { kind: "post", postId: id }, { kind: "song", songKey: id },
    { kind: "review", reviewId: "recording_role:1" }, { kind: "result", reviewId: "recording_role:1" },
  ] as const) {
    const url = danceUrl(current, community, route);
    assert.deepEqual(danceRoute(new URL(url.href)), { kind: "dance", communityId: community, route });
    assert.equal(url.search, current.search);
    assert.equal(url.hash, "#/songs");
    assert.equal(withoutActivity(url).href, current.href);
  }
  assert.deepEqual(danceRoute(new URL("https://community.example/?dance=" + id)), {
    kind: "dance", route: { kind: "post", postId: id },
  });
});
test("Dance never selects from conflicting/private/duplicate/malformed route identities", () => {
  const id = "0x" + "a".repeat(64), community = "opaque";
  for (const path of [
    "/?dance=", "/?dance=x", "/?dance=" + id + "&dance=" + id,
    "/?dance=" + id + "&study=song", "/?dance=" + id + "&sing=song",
    "/?dance=" + id + "&lesson=private", "/dance", "/dance/opaque",
    "/dance/" + community + "/songs/" + id + "/recording",
    "/dance/" + community + "/posts/" + id + "/extra",
    "/dance/" + community + "/reviews/%2Fother", "/dance/%00/reviews/id",
    "/dance/opaque/reviews/id?dance=" + id, "/dance/opaque/reviews/id?study=other",
    "/dance/opaque/reviews/id?lesson=other",
  ]) assert.deepEqual(danceRoute(new URL(path, "https://community.example")), { kind: "invalid" }, path);
});
test("Study/Sing replace Dance without carrying recording identities or losing feed context", () => {
  const id = "0x" + "a".repeat(64);
  const current = danceUrl(new URL("https://community.example/?language=en#/songs"), "opaque", {
    kind: "review", reviewId: "recording_role",
  });
  for (const kind of ["study", "sing"] as const) {
    const next = activityUrl(current, kind, id);
    assert.equal(next.pathname, "/"); assert.equal(next.hash, "#/songs");
    assert.equal(next.searchParams.get("language"), "en");
    assert.equal(danceRoute(next).kind, "none");
    assert.deepEqual(activityRoute(next), { kind, postId: id });
  }
  assert.equal(activityRoute(new URL("https://community.example/?dance=" + id + "&sing=other")).kind, "invalid");
});
