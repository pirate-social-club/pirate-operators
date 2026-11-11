/** Controlled admission-boundary races; actual lane SQL in memory SQLite. */
import test from "node:test";
import assert from "node:assert/strict";
import { sqliteDanceFixture } from "./dance-sqlite-fixture.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";
import { LOCAL_REVIEWER_ALLOWED_SQL } from "../packages/dance/local-guards.ts";
import { decisionIntent } from "../packages/dance/intent.ts";

async function delegated() {
  const f = sqliteDanceFixture();
  const input = {
    delegationId: "grant_moderator",
    accountId: "moderator",
    operation: "grant" as const,
    expiresAtMs: Date.now() + 86400000,
  };
  await f.service.permissions.delegate("owner", "grant_command", input);
  // Explicit modeled ACCEPTED chain fact; the local grant itself grants nothing.
  f.model.delegates.add("moderator");
  const { review } = await f.pending();
  const revoke = () =>
    f.service.permissions.delegate("owner", "revoke_command", {
      ...input,
      operation: "revoke",
      expiresAtMs: 0,
    });
  return { ...f, review, revoke };
}
const decide = (
  f: Awaited<ReturnType<typeof delegated>>,
  actor = "moderator",
) =>
  f.service.decide(
    actor,
    "race_decision",
    f.review.reviewId,
    f.review.revision,
    "pass",
    f.ports.reviewerConsent.version,
  );

test("accepted local revoke immediately before actual decision SQL rejects every decision effect", async () => {
  const f = await delegated();
  try {
    const stage = f.store.stageDecision.bind(f.store);
    f.store.stageDecision = async (input) => {
      await f.revoke();
      return stage(input);
    };
    await assert.rejects(decide(f), /dance_fence_changed/);
    const current = await f.store.review(f.review.reviewId);
    assert.equal(current.state, "awaiting_review");
    assert.equal(current.revision, 1);
    assert.equal(current.decision, null);
    assert.equal(f.db.count("dance_decision_intents"), 0);
    assert.equal(
      f.db.sqlite
        .prepare("SELECT count(*) n FROM dance_outbox WHERE kind='decision'")
        .get()!.n,
      0,
    );
    assert.equal(f.db.count("dance_receipts"), 1);
    assert.equal(
      (await f.ports.authority(f.model.pin.communityId, "moderator", "learner"))
        .reviewer?.canonicalAccepted,
      true,
    );
    assert.ok(
      f.db.executed.some((sql) => sql.includes(LOCAL_REVIEWER_ALLOWED_SQL)),
    );
  } finally {
    f.close();
  }
});
test("store itself supplies the native revoke predicate even if caller fences omit it", async () => {
  const f = await delegated();
  try {
    const reviewer = await f.service.permissions.reviewer(
      await f.service.permissions.facts("moderator", "learner"),
    );
    const intent = decisionIntent(
      f.review,
      "native_guard",
      "pass",
      reviewer,
      await f.store.now(),
    );
    await f.revoke();
    await assert.rejects(
      f.store.stageDecision({
        review: f.review,
        actor: "moderator",
        requestHash: "native_request",
        intent,
        fences: [{ sql: "1", values: [] }],
      }),
      /dance_fence_changed/,
    );
    assert.equal(f.db.count("dance_decision_intents"), 0);
  } finally {
    f.close();
  }
});

test("private result rechecks local revoke after its last awaited clock observation", async () => {
  const f = await delegated();
  try {
    let clocks = 0;
    f.db.beforeRead = async (sql) => {
      if (sql === "SELECT " + DANCE_DB_NOW + " AS n" && ++clocks === 2) {
        f.db.beforeRead = null;
        await f.revoke();
      }
    };
    await assert.rejects(
      f.service.get("moderator", f.review.reviewId),
      /dance_fence_changed/,
    );
    assert.equal(clocks, 2);
  } finally {
    f.close();
  }
});

test("private playback rechecks local revoke after the awaited media readiness response", async () => {
  const f = await delegated();
  try {
    const ready = f.ports.media.readyForReview;
    f.ports.media.readyForReview = async (...args) => {
      const result = await ready(...args);
      await f.revoke();
      return result;
    };
    await assert.rejects(
      f.service.inspect("moderator", f.review.reviewId),
      /dance_fence_changed/,
    );
  } finally {
    f.close();
  }
});

test("queue final admission carries local reviewer guard after rows have been observed", async () => {
  const f = await delegated();
  try {
    const check = f.store.assert.bind(f.store);
    let revoked = false;
    f.store.assert = async (fences) => {
      if (
        fences.length === 2 &&
        fences.some((v) => v.sql === LOCAL_REVIEWER_ALLOWED_SQL)
      ) {
        revoked = true;
        await f.revoke();
      }
      return check(fences);
    };
    await assert.rejects(f.service.queue("moderator"), /dance_fence_changed/);
    assert.equal(revoked, true);
  } finally {
    f.close();
  }
});

test("private receipt recovery rechecks local revoke after the receipt read", async () => {
  const f = await delegated();
  try {
    await decide(f);
    const receipt = f.store.receipt.bind(f.store);
    let reads = 0;
    f.store.receipt = async (...args) => {
      const result = await receipt(...args);
      if (++reads === 2) await f.revoke();
      return result;
    };
    await assert.rejects(decide(f), /dance_fence_changed/);
    assert.equal(reads, 2);
    assert.equal(f.db.count("dance_decision_intents"), 1);
  } finally {
    f.close();
  }
});

async function dispatchFixture(actor = "owner") {
  const f = await delegated();
  await decide(f, actor);
  // Test-only protocol admission projection; no ABI/source acceptance is implied.
  f.db.sqlite
    .prepare(
      "UPDATE dance_outbox SET status='ready' WHERE command_id='race_decision'",
    )
    .run();
  const withdraw = async () => {
    const r = await f.store.review(f.review.reviewId);
    return f.service.end(
      "learner",
      "withdraw_race",
      r.reviewId,
      r.revision,
      "withdraw",
    );
  };
  return { ...f, withdraw };
}

test("dispatch preparation admits only ready/unknown/orphaned; every final/held status refuses", async () => {
  const f = await dispatchFixture();
  try {
    for (const status of [
      "ready",
      "unknown",
      "orphaned",
      "held",
      "canceled",
      "latest",
      "safe",
    ] as const) {
      f.db.sqlite
        .prepare(
          "UPDATE dance_outbox SET status=? WHERE command_id='race_decision'",
        )
        .run(status);
      if (["ready", "unknown", "orphaned"].includes(status))
        assert.equal(
          (await f.service.prepareDispatch("owner", f.review.reviewId)).status,
          status,
        );
      else
        await assert.rejects(
          f.service.prepareDispatch("owner", f.review.reviewId),
          /dance_protocol_admission_held|dance_dispatch_unavailable/,
        );
    }
    assert.equal(f.db.count("dance_transaction_attempts"), 0);
  } finally {
    f.close();
  }
});
test("a canonical final projection cannot dispatch even if an outbox status is erroneously made ready", async () => {
  const f = await dispatchFixture();
  try {
    const r = await f.store.review(f.review.reviewId);
    // Typed fixture observation only; not actual receipt/log/block verification.
    await f.store.observe(
      r.reviewId,
      r.decision!,
      f.model.canonical(r.decision!),
    );
    f.db.sqlite
      .prepare(
        "UPDATE dance_outbox SET status='ready' WHERE command_id='race_decision'",
      )
      .run();
    await assert.rejects(
      f.service.prepareDispatch("owner", r.reviewId),
      /dance_dispatch_unavailable/,
    );
    await assert.rejects(
      f.store.attempt(
        {
          attemptId: "final_attempt",
          commandId: "race_decision",
          nonce: "1",
          rawTransaction: "fixture never broadcast",
          transactionHash: "fixture_hash",
        },
        [{ sql: "1", values: [] }],
      ),
      /dance_fence_changed/,
    );
    assert.equal(f.db.count("dance_transaction_attempts"), 0);
  } finally {
    f.close();
  }
});

for (const boundary of [
  "before_outbox",
  "after_outbox",
  "inside_final_guard",
] as const) {
  test(`withdrawal at ${boundary} cannot escape dispatch preparation`, async () => {
    const f = await dispatchFixture();
    try {
      const outbox = f.store.outbox.bind(f.store);
      let fired = false;
      if (boundary === "inside_final_guard") {
        const check = f.store.assertDispatch.bind(f.store);
        f.store.assertDispatch = async (...args) => {
          f.db.beforeBatch = async () => {
            fired = true;
            await f.withdraw();
          };
          return check(...args);
        };
      } else
        f.store.outbox = async (key) => {
          if (key !== "race_decision" || fired) return outbox(key);
          fired = true;
          if (boundary === "before_outbox") {
            await f.withdraw();
            return outbox(key);
          }
          const stale = await outbox(key);
          await f.withdraw();
          return stale;
        };
      await assert.rejects(
        f.service.prepareDispatch("owner", f.review.reviewId),
        /dance_dispatch_unavailable|dance_fence_changed/,
      );
      assert.equal(fired, true);
      assert.equal((await f.store.review(f.review.reviewId)).localDenied, true);
      assert.equal(f.db.count("dance_transaction_attempts"), 0);
    } finally {
      f.close();
    }
  });
}

for (const status of ["ready", "unknown", "orphaned"] as const) {
  test(`final actual attempt guard blocks withdrawal after ${status} preparation`, async () => {
    const f = await dispatchFixture();
    try {
      f.db.sqlite
        .prepare(
          "UPDATE dance_outbox SET status=? WHERE command_id='race_decision'",
        )
        .run(status);
      await f.service.prepareDispatch("owner", f.review.reviewId);
      const oldPayload = (await f.store.outbox("race_decision")).payloadJson;
      f.db.beforeBatch = async () => {
        await f.withdraw();
      };
      await assert.rejects(
        f.store.attempt(
          {
            attemptId: "attempt_1",
            commandId: "race_decision",
            nonce: "1",
            rawTransaction: "fixture never broadcast",
            transactionHash: "fixture_hash",
          },
          [{ sql: "1", values: [] }],
        ),
        /dance_fence_changed/,
      );
      assert.equal(f.db.count("dance_transaction_attempts"), 0);
      assert.equal(
        (await f.store.outbox("race_decision")).payloadJson,
        oldPayload,
      );
    } finally {
      f.close();
    }
  });
}

test("late reviewer revocation also fences dispatch and actual attempt admission", async () => {
  const f = await dispatchFixture("moderator");
  try {
    await f.service.prepareDispatch("moderator", f.review.reviewId);
    const outbox = f.store.outbox.bind(f.store);
    f.store.outbox = async (key) => {
      const old = await outbox(key);
      await f.revoke();
      return old;
    };
    await assert.rejects(
      f.service.prepareDispatch("moderator", f.review.reviewId),
      /dance_fence_changed/,
    );
    await assert.rejects(
      f.store.attempt(
        {
          attemptId: "revoked_attempt",
          commandId: "race_decision",
          nonce: "2",
          rawTransaction: "fixture never broadcast",
          transactionHash: "revoked_hash",
        },
        [{ sql: "1", values: [] }],
      ),
      /dance_fence_changed/,
    );
    assert.equal(f.db.count("dance_transaction_attempts"), 0);
  } finally {
    f.close();
  }
});

test("valid attempt is append-only; stale supplied authority fence rolls the attempt/status back", async () => {
  const f = await dispatchFixture();
  try {
    const attempt = {
      attemptId: "valid_attempt",
      commandId: "race_decision",
      nonce: "1",
      rawTransaction: "fixture bytes, never broadcast",
      transactionHash: "fixture_hash",
    };
    await assert.rejects(
      f.store.attempt(attempt, []),
      /dance_dispatch_fence_required/,
    );
    await assert.rejects(
      f.store.attempt(attempt, [{ sql: "0", values: [] }]),
      /dance_fence_changed/,
    );
    assert.equal((await f.store.outbox("race_decision")).status, "ready");
    await f.store.attempt(attempt, [{ sql: "1", values: [] }]);
    assert.equal((await f.store.outbox("race_decision")).status, "unknown");
    assert.equal(f.db.count("dance_transaction_attempts"), 1);
    await assert.rejects(
      f.db.prepare("DELETE FROM dance_transaction_attempts").run(),
      /dance_attempt_immutable/,
    );
  } finally {
    f.close();
  }
});

test("identical grants/revokes recover old bytes after canonical epochs advance and target becomes inactive", async () => {
  const f = sqliteDanceFixture();
  try {
    let epoch = 0,
      reads = 0;
    f.ports.reviewerRoleEpoch = async () => {
      reads++;
      return epoch;
    };
    const input = {
      delegationId: "grant_moderator",
      accountId: "moderator",
      operation: "grant" as const,
      expiresAtMs: Date.now() + 86400000,
    };
    const first = await f.service.permissions.delegate(
      "owner",
      "original_grant",
      input,
    );
    const bytes = (await f.store.outbox(first.commandId)).payloadJson;
    epoch = 1;
    f.model.setOwner();
    f.model.principals.moderator.active = false;
    assert.deepEqual(
      await f.service.permissions.delegate("owner", "original_grant", input),
      first,
    );
    assert.equal(reads, 1);
    assert.equal((await f.store.outbox(first.commandId)).payloadJson, bytes);
    await assert.rejects(
      f.service.permissions.delegate("owner", "original_grant", {
        ...input,
        expiresAtMs: input.expiresAtMs + 1,
      }),
      /dance_idempotency_conflict/,
    );
    const revokeInput = {
      ...input,
      operation: "revoke" as const,
      expiresAtMs: 0,
    };
    const revoked = await f.service.permissions.delegate(
      "owner",
      "original_revoke",
      revokeInput,
    );
    epoch = 2;
    f.model.setOwner();
    assert.deepEqual(
      await f.service.permissions.delegate(
        "owner",
        "original_revoke",
        revokeInput,
      ),
      revoked,
    );
    assert.equal(reads, 2);
    f.model.principals.owner.active = false;
    await assert.rejects(
      f.service.permissions.delegate("owner", "original_grant", input),
      /dance_account_unavailable/,
    );
  } finally {
    f.close();
  }
});

test("control lost response recovers original accepted intent with fresh owner HTTP fence", async () => {
  const f = sqliteDanceFixture();
  try {
    f.db.afterBatch = () => {
      throw Error("fixture lost control reply AFTER COMMIT");
    };
    const input = {
      delegationId: "grant_moderator",
      accountId: "moderator",
      operation: "grant" as const,
      expiresAtMs: Date.now() + 86400000,
    };
    const accepted = await f.service.permissions.delegate(
      "owner",
      "lost_control",
      input,
    );
    assert.equal(f.db.count("dance_control_intents"), 1);
    const check = f.store.assert.bind(f.store);
    f.store.assert = async (fences) => {
      f.model.setOwner();
      return check(fences);
    };
    await assert.rejects(
      f.service.permissions.delegate("owner", "lost_control", input),
      /dance_fence_changed/,
    );
    assert.deepEqual(await f.store.controlIntent("lost_control"), accepted);
  } finally {
    f.close();
  }
});
test("a failed actual control/outbox batch leaves no grant, retained intent or guard", async () => {
  const f = sqliteDanceFixture();
  try {
    f.db.sqlite.exec(
      "CREATE TRIGGER control_fault BEFORE INSERT ON dance_outbox WHEN NEW.command_id='failed_control' BEGIN SELECT RAISE(ABORT,'fixture_control_abort'); END",
    );
    await assert.rejects(
      f.service.permissions.delegate("owner", "failed_control", {
        delegationId: "grant_moderator",
        accountId: "moderator",
        operation: "grant",
        expiresAtMs: Date.now() + 86400000,
      }),
      /fixture_control_abort/,
    );
    for (const table of [
      "dance_delegations",
      "dance_control_intents",
      "dance_outbox",
      "dance_transaction_guards",
    ])
      assert.equal(f.db.count(table), 0);
    assert.equal(await f.store.controlIntent("failed_control"), null);
  } finally {
    f.close();
  }
});
