import test from "node:test";
import assert from "node:assert/strict";
import { mediaReviewVisible } from "../apps/web/src/media/view-state.ts";

test("prepared Dance take still requires submission, whereas a completed public post cannot show Post again", () => {
  assert.equal(mediaReviewVisible("public-feed", undefined, true, false), true);
  for (const state of ["queued", "processing", "ready"] as const) {
    assert.equal(mediaReviewVisible("public-feed", state, true, false), false);
  }
  assert.equal(
    mediaReviewVisible("private-review", "ready", true, false),
    true,
  );
  assert.equal(
    mediaReviewVisible("private-review", "ready", false, false),
    true,
  ); // server preview after reload
  assert.equal(
    mediaReviewVisible("private-review", "processing", true, false),
    false,
  );
  assert.equal(
    mediaReviewVisible("private-review", "ready", true, true),
    false,
  );
});
