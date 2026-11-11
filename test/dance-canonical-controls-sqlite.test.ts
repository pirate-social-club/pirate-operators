/** Queued actual SQLite tests. Canonical/role ports in the helper are named
 * simulations; raw receipt verification has separate queued tests. */
import test from "node:test";
import assert from "node:assert/strict";
import { canonical, hashJson } from "../packages/community/common.ts";
import { storedDanceVerdictJournal } from "../services/dance-canonical-ports.ts";
import { decisionIntent } from "../packages/dance/intent.ts";
import { danceControlSimulation } from "./dance-control-simulation.ts";
import { dh, dw } from "./dance-fixture.ts";
import { keccak256 } from "viem";

test("stale E=5 cannot clear a decision already captured at 7 before local revoke acceptance", async () => {
  const f = await danceControlSimulation();
  try {
    await f.project(7);
    const { review } = await f.pending();
    await f.service.decide(
      "moderator",
      "old_decision",
      review.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    );
    const bytes = (await f.store.outbox("old_decision")).payloadJson;
    await f.revoke(5);
    await f.project(7);
    assert.equal(await f.denied(), true);
    f.db.sqlite
      .prepare(
        "UPDATE dance_outbox SET status='ready' WHERE command_id='old_decision'",
      )
      .run();
    await assert.rejects(
      f.store.attempt(
        {
          attemptId: "stale",
          commandId: "old_decision",
          nonce: "1",
          rawTransaction: "fixture not sent",
          transactionHash: "fixture",
        },
        [{ sql: "1", values: [] }],
      ),
      /dance_fence_changed/,
    );
    assert.equal((await f.store.outbox("old_decision")).payloadJson, bytes);
    assert.equal(f.db.count("dance_transaction_attempts"), 0);
  } finally {
    f.close();
  }
});

test("unresolved revoke vetoes all R; verified exact revoke needs R>E+1 and active same-anchor role", async () => {
  const f = await danceControlSimulation();
  try {
    const revoke = await f.revoke(5);
    for (const r of [5, 6, 7]) {
      await f.project(r);
      assert.equal(await f.denied(), true);
    }
    await f.simulatedVerifiedControl(revoke);
    assert.equal(await f.denied(f.context(5)), true);
    assert.equal(await f.denied(f.context(6)), true);
    assert.equal(await f.denied(), false);
    await f.project(8, { active: false });
    assert.equal(await f.denied(), true);
    await f.project(9);
    assert.equal(await f.denied(), false);
    assert.equal(
      await f.store.locallyRevoked(
        f.source.domain.communityId,
        "moderator",
        f.model.principals.moderator.wallet,
      ),
      true,
    );
  } finally {
    f.close();
  }
});

test("legitimate expected epoch zero reconciles to one and permits prospective role two", async () => {
  const f = await danceControlSimulation();
  try {
    const revoke = await f.revoke(0);
    await f.simulatedVerifiedControl(revoke);
    await f.project(2);
    assert.equal(await f.denied(), false);
  } finally {
    f.close();
  }
});
test("verified E/E+1/E+2 boundary is enforced even against active-looking lower epochs", async () => {
  const f = await danceControlSimulation();
  try {
    const revoke = await f.revoke(5);
    await f.simulatedVerifiedControl(revoke);
    for (const r of [5, 6]) {
      await f.project(r);
      assert.equal(await f.denied(), true);
    }
    await f.project(7);
    assert.equal(await f.denied(), false);
  } finally {
    f.close();
  }
});

test("every matching revoke requires its OWN proof; latest role or old grant replay is insufficient", async () => {
  const f = await danceControlSimulation();
  try {
    const a = await f.revoke(5);
    await f.simulatedVerifiedControl(a);
    await f.project(7);
    assert.equal(await f.denied(), false);
    const b = await f.revoke(7);
    await f.project(9);
    assert.equal(await f.denied(), true);
    const old = await f.store.controlIntent("initial_grant");
    assert.ok(old);
    // Merely reading/replaying an immutable old grant does not mutate a role.
    assert.deepEqual(await f.store.controlIntent("initial_grant"), old);
    assert.equal(await f.denied(), true);
    await f.simulatedVerifiedControl(b);
    await f.project(9);
    assert.equal(await f.denied(), false);
  } finally {
    f.close();
  }
});

test("owner rotation preserves old revoke floor and requires the current owner/config; owner authority is separate", async () => {
  const f = await danceControlSimulation();
  try {
    const revoke = await f.revoke(5);
    await f.simulatedVerifiedControl(revoke);
    await f.project(7);
    f.rotateOwner();
    assert.equal(await f.denied(), true);
    await f.project(7);
    assert.equal(await f.denied(), false);
    const { review } = await f.pending();
    const result = await f.service.decide(
      "owner",
      "owner_branch",
      review.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    );
    assert.equal(result?.state, "decision_pending");
    assert.equal(
      (await f.store.review(review.reviewId)).decision?.preimage.reviewer
        .ownerEpoch,
      2,
    );
  } finally {
    f.close();
  }
});

test("case-insensitive wallet match works; account-only cross-wallet/source counters never clear", async () => {
  const f = await danceControlSimulation();
  try {
    const raw = await f.revoke(5);
    await f.simulatedVerifiedControl(raw);
    await f.project(7);
    assert.equal(
      await f.denied(
        f.context(),
        "moderator",
        raw.wallet.toUpperCase().replace("0X", "0x"),
      ),
      false,
    );
    const other = dw(99);
    const stamp = await f.project(100, { wallet: other });
    assert.equal(
      await f.denied({ ...f.context(100, stamp) }, "moderator", other),
      true,
    );
    const foreign = await f.project(101, { sourceHash: dh(909) });
    assert.equal(
      await f.denied({ ...f.context(101, foreign), sourceHash: dh(909) }),
      true,
    );
  } finally {
    f.close();
  }
});

for (const malformed of [
  null,
  "5",
  true,
  1.5,
  -1,
  Number.MAX_SAFE_INTEGER + 1,
  undefined,
]) {
  test(`malformed matching epoch ${String(malformed)} vetoes even alongside valid cleared rows`, async () => {
    const f = await danceControlSimulation();
    try {
      const good = await f.revoke(5);
      await f.simulatedVerifiedControl(good);
      await f.project(7);
      const { localIntegrityHash: _old, ...body } = good;
      const broken = {
        ...body,
        commandId: "bad_epoch",
        expectedReviewerEpoch: malformed,
      };
      const jsonBody = JSON.parse(JSON.stringify(broken));
      const intent = { ...jsonBody, localIntegrityHash: hashJson(jsonBody) };
      f.db.sqlite
        .prepare("INSERT INTO dance_control_intents VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          intent.commandId,
          intent.communityId,
          intent.actorId,
          intent.delegationId,
          intent.accountId,
          intent.wallet,
          intent.operation,
          intent.localIntegrityHash,
          JSON.stringify(intent),
        );
      assert.equal(await f.denied(), true);
      const { review } = await f.pending();
      await assert.rejects(
        f.service.decide(
          "moderator",
          "bad_row_decision",
          review.reviewId,
          1,
          "pass",
          f.ports.reviewerConsent.version,
        ),
      );
      assert.equal((await f.store.review(review.reviewId)).revision, 1);
    } finally {
      f.close();
    }
  });
}

test("unknown operation and invalid JSON are vetoes rather than NULL-elided rows", async () => {
  const f = await danceControlSimulation();
  try {
    const row = await f.revoke(5);
    await f.simulatedVerifiedControl(row);
    await f.project(7);
    f.db.sqlite
      .prepare("INSERT INTO dance_control_intents VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        "unknown",
        row.communityId,
        row.actorId,
        row.delegationId,
        row.accountId,
        row.wallet,
        "unknown",
        "hash",
        "not JSON",
      );
    assert.equal(await f.denied(), true);
  } finally {
    f.close();
  }
});

test("old receipt recovery preserves original decision bytes after a fresh grant, but dispatch/attempt stays revoked", async () => {
  const f = await danceControlSimulation();
  try {
    await f.project(5);
    const { review } = await f.pending();
    const first = await f.service.decide(
      "moderator",
      "frozen",
      review.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    );
    const before = (await f.store.outbox("frozen")).payloadJson;
    const revoke = await f.revoke(5);
    await f.simulatedVerifiedControl(revoke);
    await f.project(7);
    assert.deepEqual(
      await f.service.decide(
        "moderator",
        "frozen",
        review.reviewId,
        1,
        "pass",
        f.ports.reviewerConsent.version,
      ),
      first,
    );
    assert.equal((await f.store.outbox("frozen")).payloadJson, before);
    await assert.rejects(
      f.service.prepareDispatch("moderator", review.reviewId),
    );
    f.db.sqlite
      .prepare(
        "UPDATE dance_outbox SET status='unknown' WHERE command_id='frozen'",
      )
      .run();
    await assert.rejects(
      f.store.attempt(
        {
          attemptId: "late",
          commandId: "frozen",
          nonce: "1",
          rawTransaction: "fixture",
          transactionHash: "fixture",
        },
        [{ sql: "1", values: [] }],
      ),
    );
    assert.equal(
      f.db.sqlite
        .prepare(
          "SELECT count(*) n FROM dance_transaction_attempts WHERE command_id='frozen'",
        )
        .get()!.n,
      0,
    );
  } finally {
    f.close();
  }
});

test("revoke/regrant between preparation and final attempt evaluates immutable captured epoch in SQLite", async () => {
  const f = await danceControlSimulation();
  try {
    const revoke = await f.revoke(5);
    await f.simulatedVerifiedControl(revoke);
    await f.project(7);
    const { review } = await f.pending();
    await f.service.decide(
      "moderator",
      "prepared",
      review.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    );
    f.db.sqlite
      .prepare(
        "UPDATE dance_outbox SET status='ready' WHERE command_id='prepared'",
      )
      .run();
    await f.service.prepareDispatch("moderator", review.reviewId);
    f.db.beforeBatch = async () => {
      const next = await f.revoke(7);
      await f.simulatedVerifiedControl(next);
      await f.project(9);
    };
    await assert.rejects(
      f.store.attempt(
        {
          attemptId: "after_regrant",
          commandId: "prepared",
          nonce: "2",
          rawTransaction: "fixture",
          transactionHash: "fixture",
        },
        [{ sql: "1", values: [] }],
      ),
      /dance_fence_changed/,
    );
    assert.equal(
      f.db.sqlite
        .prepare(
          "SELECT count(*) n FROM dance_transaction_attempts WHERE command_id='prepared'",
        )
        .get()!.n,
      0,
    );
    assert.equal((await f.store.outbox("prepared")).status, "ready");
  } finally {
    f.close();
  }
});

test("projection regression, uncertainty and reorg demotion retain evidence and deny clearance", async () => {
  const f = await danceControlSimulation();
  try {
    const revoke = await f.revoke(5),
      e = await f.simulatedVerifiedControl(revoke);
    await f.project(7);
    assert.equal(await f.denied(), false);
    await assert.rejects(f.project(6), /dance_role_projection_regressed/);
    await f.journal.record({
      ...e,
      state: "orphaned",
      reason: "simulated_reorg",
    });
    assert.equal(await f.denied(), true);
    assert.ok(f.db.count("dance_control_observations") >= 2);
    const canonicalCount = f.db.sqlite
      .prepare(
        "SELECT count(*) n FROM dance_control_observations WHERE state='canonical'",
      )
      .get()!.n;
    assert.equal(typeof canonicalCount, "number");
    assert.ok(typeof canonicalCount === "number" && canonicalCount > 0);
    await f.journal.holdRole(
      f.source.domain.communityId,
      f.source.sourceHash,
      revoke.wallet,
      "simulated_rpc_uncertainty",
    );
    assert.equal(await f.denied(), true);
  } finally {
    f.close();
  }
});

test("late evidence-only attempt retention never requires send admission and cannot clear a revoke", async () => {
  const f = await danceControlSimulation();
  try {
    const revoke = await f.revoke(5);
    await f.simulatedVerifiedControl(revoke, false);
    await f.project(7);
    assert.equal(await f.denied(), true);
    assert.equal(f.db.count("dance_attempt_admissions"), 0);
    const rows = await f.journal.attempts(revoke.commandId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].guardedBindingHash, null);
    await f.store.retainAttemptEvidence(rows[0]);
    assert.equal(
      (await f.journal.attempts(revoke.commandId))[0].rawTransaction,
      rows[0].rawTransaction,
    );
    assert.equal((await f.store.outbox(revoke.commandId)).status, "held");
  } finally {
    f.close();
  }
});
for (const bad of [
  null,
  "7",
  true,
  0,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  undefined,
]) {
  test(`current/captured malformed role epoch ${String(bad)} cannot admit a final attempt`, async () => {
    const f = await danceControlSimulation();
    try {
      const revoke = await f.revoke(5);
      await f.simulatedVerifiedControl(revoke);
      await f.project(7);
      const { review } = await f.pending();
      const reviewer = await f.service.permissions.reviewer(
        await f.service.permissions.facts("moderator", "learner"),
      );
      const intent = decisionIntent(
        review,
        "malformed_capture",
        "pass",
        reviewer,
        await f.store.now(),
      );
      const p = JSON.parse(JSON.stringify(intent.preimage));
      if (bad === undefined) delete p.reviewer.roleEpoch;
      else p.reviewer.roleEpoch = bad;
      const bytes = canonical(p),
        hash = hashJson(p);
      f.db.sqlite
        .prepare(
          "UPDATE dance_reviews SET state='decision_pending',revision=2 WHERE review_id=?",
        )
        .run(review.reviewId);
      f.db.sqlite
        .prepare("INSERT INTO dance_decision_intents VALUES(?,?,?,?)")
        .run(review.reviewId, intent.commandId, bytes, hash);
      f.db.sqlite
        .prepare(
          "INSERT INTO dance_outbox VALUES(?,?,?,'decision',?,?,'ready')",
        )
        .run(
          intent.commandId,
          review.capture.communityId,
          review.reviewId,
          bytes,
          hash,
        );
      await assert.rejects(
        f.store.attempt(
          {
            attemptId: "bad_capture_attempt",
            commandId: intent.commandId,
            nonce: "1",
            rawTransaction: "fixture",
            transactionHash: "fixture",
          },
          [{ sql: "1", values: [] }],
        ),
      );
      assert.equal(
        f.db.sqlite
          .prepare(
            "SELECT count(*) n FROM dance_transaction_attempts WHERE command_id=?",
          )
          .get(intent.commandId)!.n,
        0,
      );
      assert.equal((await f.store.outbox(intent.commandId)).status, "ready");
      f.setCurrent(bad as number);
      await assert.rejects(
        f.service.permissions.reviewer(
          await f.service.permissions.facts("moderator", "learner"),
        ),
      );
    } finally {
      f.close();
    }
  });
}
test("receipt discovery retains already-broadcast verdict bytes/hash after withdrawal without another send", async () => {
  const f = await danceControlSimulation();
  try {
    const { review } = await f.pending();
    await f.service.decide(
      "owner",
      "already_sent",
      review.reviewId,
      1,
      "pass",
      f.ports.reviewerConsent.version,
    );
    const payload = (await f.store.outbox("already_sent")).payloadJson;
    await f.service.end(
      "learner",
      "stop_access",
      review.reviewId,
      2,
      "withdraw",
    );
    const rawTransaction = "0x010203",
      transactionHash = keccak256(rawTransaction);
    const attempt = {
      attemptId: "legacy_sent",
      commandId: "already_sent",
      nonce: "1",
      rawTransaction,
      transactionHash,
    };
    await assert.rejects(f.store.attempt(attempt, [{ sql: "1", values: [] }]));
    await f.store.retainAttemptEvidence(attempt);
    await f.store.retainAttemptEvidence(attempt);
    await f.store.retainAttemptEvidence({
      ...attempt,
      attemptId: "recovered_same_hash",
    });
    assert.deepEqual(
      await storedDanceVerdictJournal(
        f.db.asD1(),
        review.capture.communityId as `0x${string}`,
      ).attempts("already_sent"),
      [transactionHash],
    );
    assert.equal((await f.store.outbox("already_sent")).payloadJson, payload);
    assert.equal((await f.store.outbox("already_sent")).status, "canceled");
    assert.equal(f.db.count("dance_transaction_attempts"), 0);
    assert.equal(f.db.count("dance_recovered_attempts"), 1);
  } finally {
    f.close();
  }
});
