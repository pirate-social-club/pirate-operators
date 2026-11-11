import test from "node:test";
import assert from "node:assert/strict";
import {
  learningRoute,
  learningRouteUrl,
} from "../apps/web/src/karaoke/learning-route.ts";
test("Karaoke route survives refresh, preserves unrelated query and never carries a ticket", () => {
  const song = "0x" + "b".repeat(64);
  const initial = new URL(
    `https://community.example/?study=${song}&lesson=old&learner=fixture`,
  );
  const singing = learningRouteUrl(initial, {
    activity: "karaoke",
    postId: song,
  });
  assert.deepEqual(learningRoute(new URL(singing.toString())), {
    activity: "karaoke",
    postId: song,
  });
  assert.equal(singing.searchParams.get("learner"), "fixture");
  assert.equal(singing.searchParams.has("lesson"), false);
  assert.equal(learningRoute(learningRouteUrl(singing, null)), null);
  assert.equal(
    learningRoute(
      new URL(`https://community.example/?study=${song}&sing=${song}`),
    ),
    null,
  );
  assert.equal(
    learningRoute(new URL("https://community.example/?sing=invalid")),
    null,
  );
});
