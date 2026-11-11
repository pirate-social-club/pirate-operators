// UNRUN. Coordinator index/proof/shared gate mounts are prerequisites.
import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../packages/protocol/index.ts";
import {
  bootstrapKey,
  headKey,
  opKey,
  LinkedWithdrawalPending,
  type WithdrawalHead,
} from "../services/study-linked-withdrawal-contract.ts";
import {
  stageLinkedWithdrawal,
  discoverLinkedWithdrawal,
  guardLinkedBinding,
  prepareLinkedBind,
  commitLinkedBind,
} from "../services/study-linked-withdrawal.ts";
import {
  bootstrapLinkedWithdrawals,
  linkedWithdrawalNeedsWake,
  mergeLinkedProof,
  recoverLinkedWithdrawals,
} from "../services/study-linked-withdrawal-recovery.ts";
import { telegramStudyDenied } from "../services/study-telegram-publication.ts";
import { legacyResultGate } from "../services/learning-transactions.ts";
import type { Env } from "../services/runtime.ts";
import {
  linkedFixture,
  scope,
  target,
  source,
  communityId,
  boot,
  prove,
  proofFor,
} from "./learning-linked-withdrawal-fixture.ts";
const stage = (
  store: ReturnType<ReturnType<typeof linkedFixture>["store"]>,
  id: string,
) =>
  stageLinkedWithdrawal(store, {
    id,
    scope,
    kind: "observed",
    identity: { cutoff: 500, nonce: "1" },
  });

test("indexed multipage discovery covers every captured original without D1, survives lost page reply/restart and preserves later authority", async () => {
  const f = linkedFixture();
  try {
    let db = f.store();
    for (let i = 0; i < 123; i++) {
      const b = f.binding(i, i === 122 ? 700 : 100);
      db.set("studyBinding:" + b.offer.lessonId, b);
    }
    await boot(db);
    await db.durableStudyWrite(() => stage(db, "observation-1"));
    prove(db, "observation-1");
    const revision = db.get<WithdrawalHead>(headKey(scope))!.revision;
    assert.equal(discoverLinkedWithdrawal(db, scope, revision), true);
    db = f.store(); // Lost response/restart: only committed SQLite state survives.
    assert.equal(discoverLinkedWithdrawal(db, scope, revision), true);
    assert.equal(discoverLinkedWithdrawal(db, scope, revision), true);
    for (let i = 0; i < 123; i++) {
      const b = f.binding(i, i === 122 ? 700 : 100);
      assert.equal(
        telegramStudyDenied(db, b.offer.telegramFence!, {
          communityId,
          lessonId: b.offer.lessonId,
          learner: scope.learner,
          startedAt: b.offer.startedAt,
          authorizationId: b.authorization.id,
          contract: target.contract,
        }),
        i !== 122,
      );
    }
    assert.equal(guardLinkedBinding(db, f.binding(122, 700)), false);
  } finally {
    f.close();
  }
});
test("an unresolved learner cannot starve a later durable page and a late read cannot mutate the journal", async () => {
  const f = linkedFixture();
  try {
    const db = f.store(),
      other = { ...scope, learner: `0x${"22".repeat(20)}` as const };
    await boot(db);
    stage(db, "unavailable");
    stageLinkedWithdrawal(db, {
      id: "available",
      scope: other,
      kind: "observed",
      identity: { cutoff: 500, nonce: "1" },
    });
    let aborted = false;
    await recoverLinkedWithdrawals(
      db,
      {
        source: () => source,
        original: () => null,
        observe: async (input, signal) => {
          if (input.learner === scope.learner) {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
            return new Promise<null>(() => {});
          }
          const p = proofFor(db, "available"),
            { proofHash: _old, ...body } = p;
          const changed = { ...body, learner: other.learner };
          return { ...changed, proofHash: digest(changed) };
        },
      },
      2,
      5,
    );
    assert.equal(aborted, true);
    assert.equal(db.get<WithdrawalHead>(headKey(scope))!.openProofs, 1);
    assert.equal(db.get<WithdrawalHead>(headKey(other))!.openProofs, 0);
    assert.equal(db.get<WithdrawalHead>(headKey(other))!.sealed, true);
  } finally {
    f.close();
  }
});
test("temporary pending is an error, not permanent denial; unaffected result gets no tombstone", async () => {
  const f = linkedFixture();
  try {
    const db = f.store(),
      b = f.binding(1, 700);
    db.set("studyBinding:" + b.offer.lessonId, b);
    await boot(db);
    stage(db, "pending");
    assert.throws(() => guardLinkedBinding(db, b), LinkedWithdrawalPending);
    assert.equal(telegramStudyDenied(db, b.offer.telegramFence!), false);
    prove(db, "pending");
    discoverLinkedWithdrawal(
      db,
      scope,
      db.get<WithdrawalHead>(headKey(scope))!.revision,
    );
    assert.equal(guardLinkedBinding(db, b), false);
  } finally {
    f.close();
  }
});
test("pre-stage bind resuming after completed discovery fails captured head/bootstrap revision", async () => {
  const f = linkedFixture();
  try {
    const db = f.store();
    await boot(db);
    const captured = await prepareLinkedBind(db, scope);
    stage(db, "later");
    prove(db, "later");
    discoverLinkedWithdrawal(
      db,
      scope,
      db.get<WithdrawalHead>(headKey(scope))!.revision,
    );
    assert.throws(
      () => db.transaction(() => commitLinkedBind(db, captured, 700)),
      LinkedWithdrawalPending,
    );
    const fresh = await prepareLinkedBind(db, scope);
    db.transaction(() => commitLinkedBind(db, fresh, 700));
  } finally {
    f.close();
  }
});
test("canonical revert retains reverted outcome and separate recovery floor; exact retry never restages it", async () => {
  const f = linkedFixture();
  try {
    const db = f.store();
    await boot(db);
    stageLinkedWithdrawal(db, {
      id: "revert",
      scope,
      kind: "signed",
      identity: { nonce: "0" },
    });
    prove(db, "revert", 0, "0", "reverted", 600);
    discoverLinkedWithdrawal(
      db,
      scope,
      db.get<WithdrawalHead>(headKey(scope))!.revision,
    );
    const before = db.get<WithdrawalHead>(headKey(scope))!;
    stageLinkedWithdrawal(db, {
      id: "revert",
      scope,
      kind: "signed",
      identity: { nonce: "0" },
    });
    assert.deepEqual(db.get(headKey(scope)), before);
    assert.equal(before.cutoffS, 0);
    assert.equal(before.recoveryFloorS, 600);
    assert.equal(
      db.get<{ proof: { kind: string } }>(opKey("revert"))!.proof.kind,
      "reverted",
    );
    const fresh = await prepareLinkedBind(db, scope);
    assert.throws(
      () => commitLinkedBind(db, fresh, 600),
      /study_authorization_required/,
    );
    commitLinkedBind(db, fresh, 601);
  } finally {
    f.close();
  }
});
test("same-second nonce merges and larger cutoff rescans; stale completion cannot seal newer revision", async () => {
  const f = linkedFixture();
  try {
    const db = f.store(),
      b = f.binding(1, 700);
    db.set("studyBinding:" + b.offer.lessonId, b);
    await boot(db);
    stage(db, "first");
    prove(db, "first", 500, "1");
    const old = db.get<WithdrawalHead>(headKey(scope))!.revision;
    discoverLinkedWithdrawal(db, scope, old);
    stageLinkedWithdrawal(db, {
      id: "same-second",
      scope,
      kind: "observed",
      identity: { cutoff: 500, nonce: "2" },
    });
    prove(db, "same-second", 500, "2");
    assert.equal(db.get<WithdrawalHead>(headKey(scope))!.nextNonce, "2");
    stageLinkedWithdrawal(db, {
      id: "larger",
      scope,
      kind: "observed",
      identity: { cutoff: 800, nonce: "3" },
    });
    prove(db, "larger", 800, "3");
    assert.equal(discoverLinkedWithdrawal(db, scope, old), false);
    const current = db.get<WithdrawalHead>(headKey(scope))!;
    assert.equal(current.sealed, false);
    discoverLinkedWithdrawal(db, scope, current.revision);
    assert.equal(guardLinkedBinding(db, b), true);
  } finally {
    f.close();
  }
});
test("page denial and cursor rollback together on SQLite transaction failure", async () => {
  const f = linkedFixture();
  try {
    const db = f.store(),
      b = f.binding(1);
    db.set("studyBinding:" + b.offer.lessonId, b);
    await boot(db);
    stage(db, "rollback");
    prove(db, "rollback");
    const before = db.get<WithdrawalHead>(headKey(scope))!;
    f.failCommit();
    assert.throws(
      () => discoverLinkedWithdrawal(db, scope, before.revision),
      /injected_commit_failure/,
    );
    assert.deepEqual(db.get(headKey(scope)), before);
    assert.equal(
      telegramStudyDenied(db, b.offer.telegramFence!, {
        communityId,
        lessonId: b.offer.lessonId,
        learner: scope.learner,
        startedAt: b.offer.startedAt,
        authorizationId: b.authorization.id,
        contract: target.contract,
      }),
      false,
    );
  } finally {
    f.close();
  }
});
test("malformed original and behind-cursor legacy hints remain unresolved instead of disappearing", async () => {
  const f = linkedFixture();
  try {
    const db = f.store();
    await boot(db);
    db.set("legacyResultsWithheld:" + scope.learner, { at: 900, nonce: "0" });
    await assert.rejects(prepareLinkedBind(db, scope), LinkedWithdrawalPending);
    const b = f.binding(1);
    db.set("studyBinding:" + b.offer.lessonId, {
      ...b,
      offerHash: digest("wrong"),
    });
    stage(db, "malformed");
    prove(db, "malformed");
    const head = db.get<WithdrawalHead>(headKey(scope))!;
    // Resolve remaining legacy proof fixture without clearing permanent marker.
    const legacyId = digest(["legacy", scope, { at: 900, nonce: "0" }]);
    prove(db, legacyId);
    assert.throws(
      () =>
        discoverLinkedWithdrawal(
          db,
          scope,
          db.get<WithdrawalHead>(headKey(scope))!.revision,
        ),
      /study_linked_binding_invalid/,
    );
    assert.equal(db.get<WithdrawalHead>(headKey(scope))!.cursor, head.cursor);
  } finally {
    f.close();
  }
});
test("unclassified legacy rows stop bootstrap; pending wake survives last proven-erased binding", async () => {
  const f = linkedFixture();
  try {
    const db = f.store();
    db.set("legacyResultsWithheld:malformed", true);
    await bootstrapLinkedWithdrawals(db);
    assert.notEqual(db.get<{ phase: string }>(bootstrapKey)!.phase, "ready");
    db.delete("legacyResultsWithheld:malformed");
    await boot(db);
    const b = f.binding(1);
    db.set("studyBinding:" + b.offer.lessonId, b);
    stage(db, "outlives-binding");
    db.set("studyPublicationClosed:" + b.offer.lessonId, {
      kind: "binding",
      target,
      reason: "private_history_expired",
    });
    db.delete("studyBinding:" + b.offer.lessonId);
    assert.equal(linkedWithdrawalNeedsWake(f.store()), true);
    assert.throws(() => guardLinkedBinding(db, b), LinkedWithdrawalPending);
    assert.ok(f.alarm());
    assert.equal(db.get("studyBinding:" + b.offer.lessonId), undefined);
  } finally {
    f.close();
  }
});
test("actual shared resolver gate rechecks pending after delayed approval and synchronously before send", async () => {
  const f = linkedFixture();
  let release!: () => void;
  try {
    const db = f.store(),
      b = f.binding(1, 700);
    db.set("studyBinding:" + b.offer.lessonId, b);
    await boot(db);
    db.set("studyPublication:" + b.offer.lessonId, {
      target,
      telegramFence: b.offer.telegramFence,
      result: {
        learner: scope.learner,
        enrollmentId: b.authorization.id,
        startedAt: "900",
      },
    });
    const env = {
      COMMUNITY_ID: communityId,
      STUDY_TELEGRAM_AUTHORITY: {
        async fetch(_input: unknown, init: RequestInit) {
          const value = JSON.parse(String(init.body));
          await new Promise<void>((done) => {
            release = done;
          });
          return Response.json({
            schema: "pirate.study.telegram-fence-observation/1",
            hash: value.fence.hash,
            contextHash: digest(value.context),
            allowed: true,
          });
        },
      },
    } as unknown as Env;
    const gate = legacyResultGate(env, db),
      waiting = gate.withheld(
        "record_result",
        "study:" + b.offer.lessonId + ":1",
      );
    // Let the actual resolver enter its await without timing dependence.
    while (!release) await Promise.resolve();
    stage(db, "delayed");
    release();
    await assert.rejects(waiting, LinkedWithdrawalPending);
    assert.throws(
      () => gate.recorded("record_result", "study:" + b.offer.lessonId + ":1"),
      LinkedWithdrawalPending,
    );
    prove(db, "delayed");
    discoverLinkedWithdrawal(
      db,
      scope,
      db.get<WithdrawalHead>(headKey(scope))!.revision,
    );
    assert.equal(
      gate.recorded("record_result", "study:" + b.offer.lessonId + ":1"),
      false,
    );
  } finally {
    release?.();
    f.close();
  }
});

for (const kind of ["observed", "chain-marker"] as const)
  test(`safe proof must cover the retained ${kind} cutoff and nonce before completion`, async () => {
    const f = linkedFixture();
    try {
      let db = f.store();
      const b = f.binding(600, 600);
      db.set("studyBinding:" + b.offer.lessonId, b);
      await boot(db);
      const marker = {
        at: 900,
        revokedAt: "800",
        revocationNonce: "3",
        source: "chain",
      };
      const id =
        kind === "observed"
          ? "newer-signal"
          : digest(["legacy", scope, marker]);
      if (kind === "observed")
        stageLinkedWithdrawal(db, {
          id,
          scope,
          kind: "observed",
          identity: { cutoff: "800", nonce: "3" },
        });
      else {
        db.set("legacyResultsWithheld:" + scope.learner, marker);
        await assert.rejects(
          prepareLinkedBind(db, scope),
          LinkedWithdrawalPending,
        );
      }
      db = f.store(); // Retained signal, not a current default or caller timestamp.
      const before = db.get<WithdrawalHead>(headKey(scope))!;
      for (const [cutoff, nonce] of [
        [500, "1"],
        [800, "2"],
        [799, "3"],
      ] as const) {
        assert.throws(
          () => mergeLinkedProof(db, id, proofFor(db, id, cutoff, nonce)),
          LinkedWithdrawalPending,
        );
        assert.equal(
          db.get<WithdrawalHead>(headKey(scope))!.openProofs,
          before.openProofs,
        );
        assert.equal(db.get<{ proof?: unknown }>(opKey(id))!.proof, undefined);
        assert.ok(db.get("linkedWithdrawalWork:" + id));
        assert.throws(() => guardLinkedBinding(db, b), LinkedWithdrawalPending);
        assert.equal(
          db.get("linkedWithdrawalLegacy:" + digest(scope)),
          undefined,
        );
      }
      mergeLinkedProof(db, id, proofFor(db, id, 800, "3"));
      discoverLinkedWithdrawal(
        db,
        scope,
        db.get<WithdrawalHead>(headKey(scope))!.revision,
      );
      assert.equal(
        telegramStudyDenied(db, b.offer.telegramFence!, {
          communityId,
          lessonId: b.offer.lessonId,
          learner: scope.learner,
          startedAt: b.offer.startedAt,
          authorizationId: b.authorization.id,
          contract: target.contract,
        }),
        true,
      );
      if (kind === "chain-marker") {
        await recoverLinkedWithdrawals(db, {
          source: () => source,
          original: () => null,
          observe: async () => null,
        });
        assert.equal(
          db.get("linkedWithdrawalLegacy:" + digest(scope)),
          digest(marker),
        );
      }
    } finally {
      f.close();
    }
  });
test("a legacy signed canonical revert uses its original recovery floor without inventing success", async () => {
  const f = linkedFixture();
  try {
    const db = f.store();
    await boot(db);
    const marker = { at: 900, nonce: "0" },
      id = digest(["legacy", scope, marker]);
    db.set("legacyResultsWithheld:" + scope.learner, marker);
    await assert.rejects(prepareLinkedBind(db, scope), LinkedWithdrawalPending);
    mergeLinkedProof(db, id, proofFor(db, id, 0, "0", "reverted", 600));
    const h = db.get<WithdrawalHead>(headKey(scope))!;
    assert.equal(h.cutoffS, 0);
    assert.equal(h.recoveryFloorS, 600);
    assert.equal(h.nextNonce, "0");
    assert.equal(
      db.get<{ proof: { kind: string } }>(opKey(id))!.proof.kind,
      "reverted",
    );
  } finally {
    f.close();
  }
});

test("production SQLite fixture executes constructor DDL and writes eagerly without toArray", () => {
  const f = linkedFixture();
  try {
    const db = f.store();
    assert.ok(
      f.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name='records'")
        .get(),
    );
    db.set("fixture-eager", { value: 1 });
    assert.equal(
      JSON.parse(
        String(
          f.sqlite
            .prepare("SELECT value FROM records WHERE key='fixture-eager'")
            .get()!.value,
        ),
      ).value,
      1,
    );
    const snapshot = db.sql.exec<{ value: string }>(
      "SELECT value FROM records WHERE key='fixture-eager'",
    );
    db.set("fixture-eager", { value: 2 });
    assert.equal(JSON.parse(snapshot.toArray()[0].value).value, 1);
    db.delete("fixture-eager");
    assert.equal(
      f.sqlite.prepare("SELECT 1 FROM records WHERE key='fixture-eager'").get(),
      undefined,
    );
  } finally {
    f.close();
  }
});
