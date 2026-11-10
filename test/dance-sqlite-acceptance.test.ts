import test from "node:test";
import assert from "node:assert/strict";
import { sqliteDanceFixture } from "./dance-sqlite-fixture.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { decisionIntent } from "../packages/dance/intent.ts";
import { mediaBinding } from "../packages/dance/validation.ts";

test("actual SQL accepts submission, decision and withdrawal receipts atomically", async () => {
  const f = sqliteDanceFixture();
  try {
    const { review, command } = await f.pending();
    assert.equal(
      review.receipt.reviewDeadlineMs,
      review.receipt.trustedSubmittedAtMs + 604800000,
    );
    assert.equal(f.db.count("dance_receipts"), 1);
    const submission = f.db.sqlite
      .prepare("SELECT receipt_json FROM dance_receipts WHERE command_id=?")
      .get(command)!;
    assert.equal(JSON.parse(String(submission.receipt_json)).intentId, null);
    const decided = await f.service.decide(
      "owner",
      "sql_decision",
      review.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    );
    assert.ok(decided);
    assert.equal(decided.state, "decision_pending");
    assert.equal(decided.intentId, "sql_decision");
    const current = await f.store.review(review.reviewId);
    assert.equal(current.canonical, null);
    const ended = await f.service.end(
      "learner",
      "sql_withdraw",
      review.reviewId,
      current.revision,
      "withdraw",
    );
    assert.ok(ended && "intentId" in ended);
    assert.equal(ended.state, "withdrawal_pending");
    assert.equal(ended.intentId, "sql_decision");
    assert.equal(f.db.count("dance_receipts"), 3);
    assert.equal(f.db.count("dance_transaction_guards"), 0);
    assert.equal((await f.store.outbox("sql_decision")).status, "canceled");
  } finally {
    f.close();
  }
});

async function operation(
  f: ReturnType<typeof sqliteDanceFixture>,
  kind: string,
  command = "sql_receipt_fault",
) {
  if (kind === "submission") {
    const capture = await f.capture(),
      m = await f.addMedia(capture);
    const ready = await f.ports.media.readyForSubmission(
      m.id,
      mediaBinding(capture, m.recordingSha256),
      { accountId: "learner" },
    );
    const input = {
      capture,
      media: mediaBinding(capture, m.recordingSha256),
      witness: ready.witness,
      commandId: command,
      requestHash: "submission_request",
      bindingCommitment: "fixture_binding",
      fences: [{ sql: "1", values: [] }],
      mediaPort: f.ports.media,
    };
    return { actor: "learner", run: () => f.store.acceptSubmission(input) };
  }
  const { review } = await f.pending();
  if (kind === "decision") {
    const reviewer = await f.service.permissions.reviewer(
      await f.service.permissions.facts("owner", "learner"),
    );
    const intent = decisionIntent(
      review,
      command,
      "pass",
      reviewer,
      await f.store.now(),
    );
    return {
      actor: "owner",
      run: () =>
        f.store.stageDecision({
          review,
          actor: "owner",
          requestHash: "decision_request",
          intent,
          fences: [{ sql: "1", values: [] }],
        }),
    };
  }
  return {
    actor: "learner",
    run: () =>
      f.store.stageWithdrawal({
        review,
        actor: "learner",
        commandId: command,
        requestHash: "withdraw_request",
        fences: [{ sql: "1", values: [] }],
      }),
  };
}

function snapshot(f: ReturnType<typeof sqliteDanceFixture>) {
  return JSON.stringify(
    [
      "fixture_media",
      "community_media_submissions",
      "dance_reviews",
      "dance_decision_intents",
      "dance_receipts",
      "dance_outbox",
      "dance_transaction_guards",
    ].map((table) =>
      f.db.sqlite.prepare("SELECT * FROM " + table + " ORDER BY rowid").all(),
    ),
  );
}

for (const kind of ["submission", "decision", "withdrawal"]) {
  for (const fault of ["duplicate", "abort", "zero_receipt", "stale_fence"]) {
    test(`actual ${kind} SQL rolls back media/review/intent/outbox/receipt on ${fault}`, async () => {
      const f = sqliteDanceFixture();
      try {
        const op = await operation(f, kind);
        if (fault === "duplicate")
          f.db.sqlite
            .prepare("INSERT INTO dance_receipts VALUES(?,?,?,?,?)")
            .run(
              f.model.pin.communityId,
              op.actor,
              "sql_receipt_fault",
              "old_request",
              "{}",
            );
        else if (fault === "abort")
          f.db.sqlite.exec(
            "CREATE TRIGGER receipt_fault BEFORE INSERT ON dance_receipts WHEN NEW.command_id='sql_receipt_fault' BEGIN SELECT RAISE(ABORT,'fixture_receipt_abort'); END",
          );
        else if (fault === "zero_receipt")
          f.db.sqlite.exec(
            "CREATE TRIGGER receipt_fault BEFORE INSERT ON dance_receipts WHEN NEW.command_id='sql_receipt_fault' BEGIN SELECT RAISE(IGNORE); END",
          );
        else
          f.db.beforeBatch = () => {
            // Reject the actual admission statement by changing a checked resource.
            if (kind === "submission")
              f.db.sqlite.exec("UPDATE fixture_media SET revision=revision+1");
            else
              f.db.sqlite.exec("UPDATE dance_reviews SET revision=revision+1");
          };
        // Stale resource change is a separately accepted event, not rolled back.
        if (fault === "stale_fence") {
          const before = f.db.beforeBatch!;
          f.db.beforeBatch = null;
          await before([]);
        }
        const before = snapshot(f);
        await assert.rejects(
          op.run(),
          fault === "duplicate"
            ? /UNIQUE constraint/
            : fault === "abort"
              ? /fixture_receipt_abort/
              : /dance_fence_changed/,
        );
        assert.equal(snapshot(f), before);
        assert.equal(f.db.count("dance_transaction_guards"), 0);
      } finally {
        f.close();
      }
    });
  }
}

test("actual accepted submission and decision/withdrawal lost replies recover immutable original receipts", async () => {
  const f = sqliteDanceFixture();
  try {
    const c = await f.capture(),
      m = await f.addMedia(c);
    const lose = () => {
      throw Error("fixture lost response AFTER COMMIT");
    };
    f.db.afterBatch = lose;
    const submitted = await f.service.submit(
      "learner",
      "lost_submit",
      c.captureId,
      m.id,
      m.recordingSha256,
    );
    const original = (await f.store.review(c.captureId)).receipt;
    assert.deepEqual(
      await f.service.submit(
        "learner",
        "lost_submit",
        c.captureId,
        m.id,
        m.recordingSha256,
      ),
      submitted,
    );
    assert.deepEqual((await f.store.review(c.captureId)).receipt, original);
    f.db.afterBatch = lose;
    const decided = await f.service.decide(
      "owner",
      "lost_decision",
      c.captureId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    );
    assert.deepEqual(
      await f.service.decide(
        "owner",
        "lost_decision",
        c.captureId,
        1,
        "pass",
        f.ports.reviewerConsent.version,
      ),
      decided,
    );
    assert.equal(f.db.count("dance_decision_intents"), 1);
    const payload = (await f.store.outbox("lost_decision")).payloadJson;
    f.db.afterBatch = lose;
    const withdrawn = await f.service.end(
      "learner",
      "lost_withdraw",
      c.captureId,
      2,
      "withdraw",
    );
    assert.deepEqual(
      await f.service.end(
        "learner",
        "lost_withdraw",
        c.captureId,
        2,
        "withdraw",
      ),
      withdrawn,
    );
    assert.equal((await f.store.outbox("lost_decision")).payloadJson, payload);
    assert.equal(f.db.count("dance_receipts"), 3);
    assert.equal((await f.store.review(c.captureId)).canonical, null);
    const hash = DanceStore.request("withdraw", {
      reviewId: c.captureId,
      revision: 2,
    });
    assert.deepEqual(
      await f.store.receipt(c.communityId, "learner", "lost_withdraw", hash),
      withdrawn,
    );
    await assert.rejects(
      f.store.receipt(c.communityId, "learner", "lost_withdraw", "different"),
      /dance_idempotency_conflict/,
    );
  } finally {
    f.close();
  }
});
test("failed final producer-plan assertion rolls back even after actual Dance receipt INSERT", async () => {
  const f = sqliteDanceFixture();
  try {
    const op = await operation(f, "submission");
    const plan = f.ports.media.prepareMediaSubmission;
    f.ports.media.prepareMediaSubmission = (...args) => {
      const original = plan(...args);
      return {
        ...original,
        afterAcceptance: [
          ...original.afterAcceptance,
          f.store.stmt(
            "INSERT INTO dance_transaction_guards VALUES('last_plan_guard',0)",
          ),
        ],
      };
    };
    const before = snapshot(f);
    await assert.rejects(op.run(), /dance_fence_changed/);
    assert.equal(snapshot(f), before);
    assert.equal(f.db.count("community_media_submissions"), 0);
    assert.equal(f.db.count("dance_receipts"), 0);
  } finally {
    f.close();
  }
});
