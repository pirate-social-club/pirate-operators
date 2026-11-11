import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityRoute,
  activityUrl,
  appView,
  withoutActivity,
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
