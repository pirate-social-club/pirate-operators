// UNRUN. Pure routing-domain controls; actual chrome/song/profile clicks are
// additionally asserted in the original browser journeys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fragmentNavigationHref } from "../src/shell/routing.ts";
test("same-document owned fragment navigation preserves context and target precedence", () => {
  const current = new URL(
    "https://community.example/?campaign=a&tag=one&tag=two&language=en",
  );
  const next = new URL(
    fragmentNavigationHref("/?language=fr#/settings", current),
  );
  assert.equal(next.hash, "#/settings");
  assert.deepEqual(next.searchParams.getAll("tag"), ["one", "two"]);
  assert.equal(next.searchParams.get("campaign"), "a");
  assert.equal(next.searchParams.get("language"), "fr");
  for (const destination of [
    "/#/account",
    "/#/songs",
    "/#song-post",
    "/#profile-author",
  ]) {
    const result = new URL(fragmentNavigationHref(destination, current));
    assert.equal(result.pathname, current.pathname);
    assert.equal(result.searchParams.get("campaign"), "a");
    assert.equal(result.searchParams.get("language"), "en");
  }
});
test("external, full-document, other-path and non-route anchors retain their semantics", () => {
  const current = new URL("https://community.example/?campaign=a");
  for (const href of [
    "https://other.example/#/settings",
    "//other.example/#/account",
    "/wallet",
    "/?language=fr",
    "/terms#section",
    "#app-content",
    "/other#/settings",
  ])
    assert.equal(fragmentNavigationHref(href, current), href);
  assert.equal(fragmentNavigationHref("/#/settings"), "/#/settings");
  assert.equal(
    fragmentNavigationHref("/?campaign=explicit&tag=x&tag=y#/account", current),
    "https://community.example/?campaign=explicit&tag=x&tag=y#/account",
  );
});

test("query-free fragment controls preserve opaque query bytes and duplicate order", () => {
  const current = new URL(
    "https://community.example/?tag=one&campaign=a&tag=two&space=a%20b",
  );
  const next = new URL(fragmentNavigationHref("/#/account", current));
  assert.equal(next.search, current.search);
  assert.equal(next.hash, "#/account");
  assert.equal(next.origin, current.origin);
  assert.equal(next.pathname, current.pathname);
  const explicit = new URL(
    fragmentNavigationHref("/?campaign=chosen%20value#/settings", current),
  );
  assert.equal(
    explicit.search,
    "?campaign=chosen%20value&tag=one&tag=two&space=a%20b",
  );
});
