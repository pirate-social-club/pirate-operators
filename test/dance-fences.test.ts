import test from "node:test";
import assert from "node:assert/strict";
import { danceFixture } from "./dance-fixture.ts";
test("inactive delegate can be revoked by current owner plus stored grant; D1 grant is only pending", async () => {
  const f = danceFixture(),
    r = await f.prepare();
  const grant = await f.service.permissions.delegate("owner", "grant", {
    delegationId: "g",
    accountId: "moderator",
    operation: "grant",
    expiresAtMs: f.store.time + 864000,
  });
  assert.equal(grant.status, "pending_canonical");
  await assert.rejects(
    f.service.decide(
      "moderator",
      "unaccepted",
      r.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    ),
    /dance_review_forbidden/,
  );
  f.delegates.add("moderator");
  await f.service.inspect("moderator", r.reviewId);
  f.principals.moderator.active = false;
  const revoke = await f.service.permissions.delegate("owner", "revoke", {
    delegationId: "g",
    accountId: "moderator",
    operation: "revoke",
    expiresAtMs: 0,
  });
  assert.equal(revoke.status, "pending_canonical");
  f.principals.moderator.active = true;
  await assert.rejects(
    f.service.inspect("moderator", r.reviewId),
    /dance_review_locally_revoked/,
  );
});
test("self-review rejects account, wallet and intersecting KNOWN aliases without claiming unique humans", async () => {
  for (const dimension of ["account", "wallet", "alias"]) {
    const f = danceFixture(),
      r = await f.prepare();
    f.delegates.add("alternate");
    let actor = "alternate";
    if (dimension === "account") {
      actor = "learner";
      f.delegates.add(actor);
    }
    if (dimension === "wallet")
      f.principals.alternate.wallet = f.principals.learner.wallet;
    if (dimension === "alias")
      f.principals.alternate.knownAliases = ["learner"];
    await assert.rejects(
      f.service
        .inspect(actor === "learner" ? "owner" : actor, r.reviewId)
        .then(() =>
          f.service.decide(
            actor,
            "self",
            r.reviewId,
            1,
            "pass",
            f.ports.reviewerConsent.version,
          ),
        ),
      /dance_self_review/,
    );
  }
});
test("private uploader access rejects changed wallet/authorization and authoritative media loss", async () => {
  const f = danceFixture(),
    r = await f.prepare();
  f.principals.learner.wallet = f.principals.stranger.wallet;
  await assert.rejects(
    f.service.inspect("learner", r.reviewId),
    /dance_capture_authorization_changed/,
  );
  f.principals.learner.wallet = r.capture.learner.wallet;
  f.validAuthorizations.delete(r.capture.learner.authorizationId);
  f.principals.learner.authorizationId = f.principals.owner.authorizationId;
  await assert.rejects(
    f.service.get("learner", r.reviewId),
    /dance_capture_authorization_changed/,
  );
});
test("queue skips individually revoked/expired/inaccessible rows and preserves continuation", async () => {
  const f = danceFixture();
  const a = await f.prepare({ actor: "learner" }),
    b = await f.prepare({ actor: "learner2" }),
    c = await f.prepare({ actor: "learner3" });
  const ordered = [a, b, c].sort((x, y) =>
    x.reviewId.localeCompare(y.reviewId),
  );
  f.principals[
    f.store.records.get(ordered[0].reviewId)!.capture.learner.accountId
  ].active = false;
  const first = await f.service.queue("owner", null, 1);
  assert.equal(first.items.length, 1);
  assert.equal(first.skipped.count, 1);
  assert.ok(first.cursor);
  const second = await f.service.queue("owner", first.cursor, 1);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].reviewId, second.items[0].reviewId);
  assert.equal(second.cursor, null);
  f.deadMedia.add(second.items[0].receipt.mediaId);
  const after = await f.service.queue("owner");
  assert.equal(after.items.length, 1);
  assert.equal(after.skipped.count, 2);
});
test("changed authority between preparation and local intent commit refuses all effects", async () => {
  const f = danceFixture(),
    r = await f.prepare();
  f.store.onCommit = () => (f.principals.owner.active = false);
  await assert.rejects(
    f.service.decide(
      "owner",
      "race",
      r.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    ),
    /dance_fence_changed|dance_account_unavailable/,
  );
  assert.equal((await f.store.review(r.reviewId)).decision, null);
});
