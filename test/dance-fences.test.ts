import test from "node:test";
import assert from "node:assert/strict";
import { danceFixture, dh } from "./dance-fixture.ts";
import { DanceReviewService } from "../services/dance-review.ts";

test("revocation between authority read and SQL commit rolls back verdict and receipt", async () => {
  const f = await danceFixture();
  try {
    const r = await f.prepare();
    await f.service.permissions.delegate("owner", "grant", {
      delegationId: "delegate",
      accountId: "moderator",
      operation: "grant",
      expiresAtMs: f.now() + 10000,
    });
    const rules = f.ports.rules;
    f.ports.rules = async (c) => {
      await f.db
        .prepare(
          "UPDATE dance_delegations SET revoked_at_ms=? WHERE delegation_id='delegate'",
        )
        .bind(f.now())
        .run();
      return rules(c);
    };
    await assert.rejects(
      f.service.decide(
        "moderator",
        "revoked_midflight",
        r.reviewId,
        1,
        "passed",
      ),
      /dance_fence_changed/,
    );
    assert.equal((await f.service.get("learner", r.reviewId)).state, "pending");
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) n FROM dance_verdicts")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) n FROM dance_receipts WHERE command_id='revoked_midflight'",
          )
          .first<{ n: number }>()
      )?.n,
      0,
    );
    f.ports.rules = async (c) => {
      await f.db
        .prepare(
          "UPDATE fixture_authority SET active=0 WHERE account_id='learner'",
        )
        .run();
      return rules(c);
    };
    await assert.rejects(
      f.service.decide(
        "owner",
        "learner_revoked_midflight",
        r.reviewId,
        1,
        "passed",
      ),
      /dance_fence_changed/,
    );
  } finally {
    await f.dispose();
  }
});

test("unknown post-commit response reconciles original decision without changing its time", async () => {
  const f = await danceFixture();
  try {
    const r = await f.prepare();
    let fail = true;
    const db = new Proxy(f.db, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (fail) {
              fail = false;
              throw Error("fixture transport lost after actual commit");
            }
            return result;
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const api = new DanceReviewService(db, f.ports, dh(1));
    const recovered = await api.decide(
      "owner",
      "unknown",
      r.reviewId,
      1,
      "passed",
    );
    f.setNow(f.now() + 999);
    const retried = await api.decide(
      "owner",
      "unknown",
      r.reviewId,
      1,
      "passed",
    );
    assert.deepEqual(recovered, retried);
    assert.equal(retried?.verdict?.committedAtMs, f.now() - 999);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) n FROM dance_verdicts")
          .first<{ n: number }>()
      )?.n,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test("exact media binding and unique recording refuse cross-song reuse and reward retargeting", async () => {
  const f = await danceFixture();
  try {
    const original = await f.prepare();
    // A newly uploaded object with the same recording bytes cannot acquire a
    // second review or new offer, even with a fresh capture and media ID.
    await assert.rejects(
      f.prepare({ digest: original.media.recordingSha256 }),
      /UNIQUE constraint failed/,
    );
    const capture = await f.service.capture("learner", "different_capture", {
      songKey: dh(99),
      offerId: "offer_1",
      referenceId: null,
    });
    await assert.rejects(
      f.service.submit(
        "learner",
        "wrong_song",
        capture.captureId,
        original.media.id,
      ),
      /dance_media_binding_mismatch/,
    );
    f.media.get(original.media.id)!.recordingSha256 = dh(999);
    await assert.rejects(
      f.service.decide(
        "owner",
        "changed_digest",
        original.reviewId,
        1,
        "passed",
      ),
      /dance_recording_changed/,
    );
  } finally {
    await f.dispose();
  }
});

test("actual SQL clock is retained from winning verdict mutation", async () => {
  const f = await danceFixture({ realClock: true });
  try {
    const r = await f.prepare({ offer: false });
    const before = Date.now();
    const receipt = await f.service.decide(
      "owner",
      "real_clock",
      r.reviewId,
      1,
      "passed",
    );
    const after = Date.now();
    assert.ok(receipt?.verdict);
    assert.ok(
      receipt.verdict.committedAtMs >= before &&
        receipt.verdict.committedAtMs <= after,
    );
  } finally {
    await f.dispose();
  }
});
