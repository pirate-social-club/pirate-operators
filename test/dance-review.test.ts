import test from "node:test";
import assert from "node:assert/strict";
import { danceFixture, dh } from "./dance-fixture.ts";
import { REVIEW_WINDOW_MS } from "../packages/dance/contracts.ts";
import { DanceReviewService } from "../services/dance-review.ts";

test("owner categorical pass seals immutable receipt and local candidate; reject never qualifies", async () => {
  const f = await danceFixture();
  try {
    const r = await f.prepare();
    const pass = await f.service.decide(
      "owner",
      "decision_1",
      r.reviewId,
      1,
      "passed",
    );
    assert.equal(pass?.verdict?.rewardReason, "candidate_held");
    assert.equal(pass?.verdict?.committedAtMs, f.now());
    assert.equal(pass?.verdict?.score, null);
    assert.equal(pass?.verdict?.cue, "not_required");
    assert.equal(pass?.verdict?.chainAdmission, "held");
    f.setNow(f.now() + 500);
    assert.deepEqual(
      await f.service.decide("owner", "decision_1", r.reviewId, 1, "passed"),
      pass,
    );
    await assert.rejects(
      f.service.decide("owner", "decision_1", r.reviewId, 1, "not_passed"),
      /dance_idempotency_conflict/,
    );
    await assert.rejects(
      f.db.prepare("UPDATE dance_verdicts SET evidence_hash='bad'").run(),
      /dance_verdict_immutable/,
    );
    await assert.rejects(
      f.db.prepare("DELETE FROM dance_receipts").run(),
      /dance_receipt_immutable/,
    );
    const other = await f.prepare();
    const reject = await f.service.decide(
      "owner",
      "decision_2",
      other.reviewId,
      1,
      "not_passed",
    );
    assert.equal(reject?.verdict?.rewardReason, "not_passed");
  } finally {
    await f.dispose();
  }
});

test("private queue and access refuse stranger, wrong community and alternate-identity self-review", async () => {
  const f = await danceFixture();
  try {
    const r = await f.prepare();
    await assert.rejects(f.service.queue("stranger"), /dance_review_forbidden/);
    await assert.rejects(
      f.service.get("stranger", r.reviewId),
      /dance_review_forbidden/,
    );
    await assert.rejects(
      f.service.inspect("stranger", r.reviewId),
      /dance_review_forbidden/,
    );
    assert.equal((await f.service.queue("owner")).items.length, 1);
    const wrong = new DanceReviewService(f.db, f.ports, dh(99));
    await assert.rejects(wrong.get("owner", r.reviewId), /dance_not_found/);
    await f.service.permissions.delegate("owner", "grant_alt", {
      delegationId: "alt_grant",
      accountId: "alternate",
      expiresAtMs: f.now() + 50000,
      operation: "grant",
    });
    await assert.rejects(
      f.service.decide("alternate", "self", r.reviewId, 1, "passed"),
      /dance_self_review/,
    );
    assert.equal((await f.service.queue("alternate")).items.length, 0);
    const own = await f.prepare({ actor: "owner" });
    await assert.rejects(
      f.service.decide("owner", "owner_self", own.reviewId, 1, "passed"),
      /dance_self_review/,
    );
    assert.equal((await f.service.queue("owner")).items.length, 1);
  } finally {
    await f.dispose();
  }
});

test("delegation scope, expiry, revocation and owner transfer fence decisions and private access", async () => {
  const f = await danceFixture();
  try {
    const r = await f.prepare();
    await assert.rejects(
      f.service.permissions.delegate("stranger", "grant_bad", {
        delegationId: "g",
        accountId: "moderator",
        expiresAtMs: f.now() + 5000,
        operation: "grant",
      }),
      /dance_owner_required/,
    );
    await f.service.permissions.delegate("owner", "grant_1", {
      delegationId: "g",
      accountId: "moderator",
      expiresAtMs: f.now() + 5000,
      operation: "grant",
    });
    assert.equal((await f.service.queue("moderator")).items.length, 1);
    await f.service.inspect("moderator", r.reviewId);
    await f.service.permissions.delegate("owner", "revoke_1", {
      delegationId: "g",
      accountId: "moderator",
      expiresAtMs: 0,
      operation: "revoke",
    });
    await assert.rejects(
      f.service.decide("moderator", "revoked", r.reviewId, 1, "passed"),
      /dance_review_forbidden/,
    );
    await assert.rejects(
      f.service.inspect("moderator", r.reviewId),
      /dance_review_forbidden/,
    );
    await f.service.permissions.delegate("owner", "grant_2", {
      delegationId: "g2",
      accountId: "moderator",
      expiresAtMs: f.now() + 5000,
      operation: "grant",
    });
    f.setNow(f.now() + 5000);
    await assert.rejects(
      f.service.get("moderator", r.reviewId),
      /dance_review_forbidden/,
    );
    await f.service.permissions.delegate("owner", "grant_3", {
      delegationId: "g3",
      accountId: "moderator",
      expiresAtMs: f.now() + 5000,
      operation: "grant",
    });
    await f.db
      .prepare(
        "UPDATE fixture_owner SET assignment_id='assignment_2',revision=2",
      )
      .run();
    await assert.rejects(
      f.service.decide("moderator", "old_owner_grant", r.reviewId, 1, "passed"),
      /dance_review_forbidden/,
    );
  } finally {
    await f.dispose();
  }
});

test("concurrent verdicts, duplicate retries and withdrawal produce one terminal result", async () => {
  const f = await danceFixture();
  try {
    const r = await f.prepare();
    const raced = await Promise.allSettled([
      f.service.decide("owner", "race_pass", r.reviewId, 1, "passed"),
      f.service.decide("owner", "race_reject", r.reviewId, 1, "not_passed"),
      f.service.end("learner", "race_withdraw", r.reviewId, 1, "withdraw"),
    ]);
    assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
    const current = await f.service.get("learner", r.reviewId);
    assert.notEqual(current.state, "pending");
    assert.equal(current.revision, 2);
    const count = await f.db
      .prepare("SELECT count(*) AS n FROM dance_verdicts")
      .first<{ n: number }>();
    assert.equal(count?.n, current.state === "reviewed" ? 1 : 0);
    const second = await f.prepare();
    const retries = await Promise.all([
      f.service.decide("owner", "retry", second.reviewId, 1, "passed"),
      f.service.decide("owner", "retry", second.reviewId, 1, "passed"),
    ]);
    assert.deepEqual(retries[0], retries[1]);
  } finally {
    await f.dispose();
  }
});

test("verdict commit time uses inclusive opening and exclusive cutoff; delayed passes remain visible", async () => {
  const f = await danceFixture();
  try {
    const start = f.now();
    f.setWindow(start + 1000, start + 2000);
    const before = await f.prepare();
    const early = await f.service.decide(
      "owner",
      "early",
      before.reviewId,
      1,
      "passed",
    );
    assert.equal(early?.verdict?.rewardReason, "outside_window");
    const opening = await f.prepare();
    f.setNow(start + 1000);
    assert.equal(
      (
        await f.service.decide(
          "owner",
          "opening",
          opening.reviewId,
          1,
          "passed",
        )
      )?.verdict?.rewardReason,
      "candidate_held",
    );
    const last = await f.prepare();
    f.setNow(start + 1999);
    assert.equal(
      (await f.service.decide("owner", "last", last.reviewId, 1, "passed"))
        ?.verdict?.rewardReason,
      "candidate_held",
    );
    const cutoff = await f.prepare();
    f.setNow(start + 2000);
    const late = await f.service.decide(
      "owner",
      "cutoff",
      cutoff.reviewId,
      1,
      "passed",
    );
    assert.equal(late?.verdict?.rewardReason, "outside_window");
    assert.equal(late?.verdict?.committedAtMs, start + 2000);
  } finally {
    await f.dispose();
  }
});

test("seven-day review deadline is exclusive, unaffected by offer/capture expiration", async () => {
  const f = await danceFixture();
  try {
    const a = await f.prepare({ offer: false }),
      b = await f.prepare({ offer: false });
    f.setNow(a.media.uploadedAtMs + REVIEW_WINDOW_MS - 1);
    assert.equal(
      (await f.service.decide("owner", "last_ms", a.reviewId, 1, "passed"))
        ?.verdict?.rewardReason,
      "practice",
    );
    f.setNow(b.media.uploadedAtMs + REVIEW_WINDOW_MS);
    assert.equal((await f.service.get("learner", b.reviewId)).state, "expired");
    await assert.rejects(
      f.service.decide("owner", "deadline", b.reviewId, 1, "passed"),
      /dance_fence_changed/,
    );
    assert.equal(
      (await f.service.end("learner", "expire", b.reviewId, 1, "expire"))
        ?.state,
      "expired",
    );
  } finally {
    await f.dispose();
  }
});

test("media revision/state/digest, rules and learner revocation are guarded in actual batch", async () => {
  const f = await danceFixture();
  try {
    const r = await f.prepare();
    await f.db.prepare("UPDATE fixture_media SET state='withdrawn'").run();
    await assert.rejects(
      f.service.decide("owner", "media_changed", r.reviewId, 1, "passed"),
      /dance_fence_changed/,
    );
    assert.equal((await f.service.get("learner", r.reviewId)).state, "pending");
    await f.db.prepare("UPDATE fixture_media SET state='ready'").run();
    await f.db.prepare("UPDATE fixture_rules SET revision=2").run();
    await assert.rejects(
      f.service.decide("owner", "rules_changed", r.reviewId, 1, "passed"),
      /dance_fence_changed/,
    );
    await f.db.prepare("UPDATE fixture_rules SET revision=1").run();
    await f.db
      .prepare(
        "UPDATE fixture_authority SET active=0 WHERE account_id='learner'",
      )
      .run();
    await assert.rejects(
      f.service.decide("owner", "account_revoked", r.reviewId, 1, "passed"),
      /dance_account_unavailable/,
    );
    await f.db
      .prepare(
        "UPDATE fixture_authority SET active=1,revision=2 WHERE account_id='learner'",
      )
      .run();
    await assert.rejects(
      f.service.inspect("learner", r.reviewId),
      /dance_capture_authorization_changed/,
    );
    await f.db
      .prepare(
        "UPDATE fixture_authority SET identity_id='new_identity' WHERE account_id='learner'",
      )
      .run();
    await assert.rejects(
      f.service.inspect("learner", r.reviewId),
      /dance_identity_changed/,
    );
  } finally {
    await f.dispose();
  }
});

test("approved practice, closed offer and unadmitted source never claim an eligible reward", async () => {
  const f = await danceFixture();
  try {
    const p = await f.prepare({ offer: false });
    assert.equal(
      (await f.service.decide("owner", "practice", p.reviewId, 1, "passed"))
        ?.verdict?.rewardReason,
      "practice",
    );
    const closed = await f.prepare();
    await f.db.prepare("UPDATE fixture_offer SET open=0,revision=2").run();
    assert.equal(
      (await f.service.decide("owner", "closed", closed.reviewId, 1, "passed"))
        ?.verdict?.rewardReason,
      "offer_closed",
    );
    const held = await f.prepare();
    await f.db.prepare("UPDATE fixture_offer SET admitted=0,revision=3").run();
    assert.equal(
      (await f.service.decide("owner", "held", held.reviewId, 1, "passed"))
        ?.verdict?.rewardReason,
      "source_not_admitted",
    );
  } finally {
    await f.dispose();
  }
});
