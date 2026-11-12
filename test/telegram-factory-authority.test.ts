import { test } from "node:test";
import assert from "node:assert/strict";
import { factoryAuthorityFixture } from "./telegram-factory-authority-fixture.ts";
import { deferred } from "./telegram-connected-factory-fixture.ts";
import { accounts } from "../harness/runtime.ts";

// UNRUN: combines the repaired native factory with actual 7ea D1 guard/recovery,
// actual SQL journal, signed operator handler and durable controller restart.
test(
  "unavailable real D1 guard retains the sealed transition and wake; restarted factory completes the original through shared recovery",
  { timeout: 90000 },
  async () => {
    const fixture = await factoryAuthorityFixture(20347),
      { f } = fixture;
    try {
      let bypassCalls = 0;
      Object.assign(f.options, {
        authorityValidation: async () => {
          bypassCalls++;
        },
      });
      f.restart();
      f.guardUnavailable(true);
      await assert.rejects(fixture.progress());
      const original = await fixture.read();
      assert.ok(original?.transition_id);
      assert.equal(original.sealed, 1);
      assert.equal(original.complete, 0);
      assert.ok(
        f.guardReads() > 0,
        "factory must inject the actual D1 validator",
      );
      assert.equal(
        bypassCalls,
        0,
        "even an untyped caller cannot replace the derived validator",
      );
      const before = f.journal.store.get<{
        complete: boolean;
        acknowledged: number;
        requestHash: string;
      }>("publication-transition:" + original.transition_id);
      assert.ok(before);
      assert.equal(before.acknowledged, 0);
      assert.equal(before.complete, false);
      assert.ok(f.alarm !== null);
      assert.equal(f.shared.store.entries("studyTelegramTombstone:").length, 0);
      const closed = await f.shared.db
        .prepare("SELECT state_json FROM study_lessons WHERE lesson_id=?")
        .bind(fixture.lessonId)
        .first<{ state_json: string }>();
      assert.ok(closed);
      assert.notEqual(
        JSON.parse(closed.state_json).status,
        "active",
        "local closure precedes guarded remote invalidation",
      );
      f.restart();
      f.shared.advance(65_000);
      await fixture.recover();
      await f.factory.alarm();
      assert.equal((await fixture.read())?.complete, 0);
      assert.equal(f.shared.store.entries("studyTelegramTombstone:").length, 0);
      f.guardUnavailable(false);
      f.restart();
      for (
        let step = 0;
        step < 12 && !(await fixture.read())?.complete;
        step++
      ) {
        f.shared.advance(65_000);
        // Canonical SQL dirty/outbox drain and native transition recovery both
        // run without an ordinary ready() precondition around the pair.
        await fixture.recover();
        await f.factory.alarm();
      }
      const completed = await fixture.read();
      assert.ok(completed);
      assert.equal(completed.complete, 1);
      assert.equal(completed.operation_id, original.operation_id);
      assert.equal(completed.request_json, original.request_json);
      assert.equal(completed.transition_id, original.transition_id);
      assert.equal(completed.epoch, original.epoch);
      const remote = f.journal.store.get<{
        complete: boolean;
        requestHash: string;
      }>("publication-transition:" + original.transition_id);
      assert.ok(remote);
      assert.equal(remote.complete, true);
      assert.equal(remote.requestHash, before.requestHash);
      assert.ok(f.shared.store.entries("studyTelegramTombstone:").length > 0);
      const receipts = f.shared.store.entries("studyTelegramTombstone:");
      await fixture.recover();
      await f.factory.alarm();
      assert.deepEqual(
        f.shared.store.entries("studyTelegramTombstone:"),
        receipts,
      );
      assert.equal(f.shared.counts().calls, 0);
      assert.equal(bypassCalls, 0);
    } finally {
      await f.dispose();
    }
  },
);

for (const change of ["epoch", "credential"])
  test(
    `a ${change} change during the actual delivery guard prevents every remote send and transition completion`,
    { timeout: 90000 },
    async () => {
      const fixture = await factoryAuthorityFixture(
          change === "epoch" ? 20348 : 20350,
        ),
        { f } = fixture;
      try {
        const entered = deferred(),
          release = deferred();
        let once = true;
        f.afterGuardRead(async () => {
          if (once) {
            once = false;
            entered.resolve();
            await release.promise;
          }
        });
        const processing = fixture.progress();
        try {
          await entered.promise;
          if (change === "epoch")
            await f.shared.db
              .prepare(
                "UPDATE learning_authority_heads SET revision=revision+1 WHERE account_id=?",
              )
              .bind(f.session.account_id)
              .run();
          else
            await f.shared.db
              .prepare(
                "UPDATE credential_bindings SET subject=? WHERE binding_id=?",
              )
              .bind(accounts[4].address.toLowerCase(), f.session.binding_id)
              .run();
        } finally {
          release.resolve();
        }
        await assert.rejects(processing);
        const state = await fixture.read();
        assert.ok(state?.transition_id);
        assert.equal(state.complete, 0);
        assert.equal(
          f.shared.store.entries("studyTelegramTombstone:").length,
          0,
        );
        assert.ok(f.alarm !== null);
        f.afterGuardRead();
        f.restart();
        f.shared.advance(65_000);
        await f.factory.alarm();
        assert.equal((await fixture.read())?.complete, 0);
        assert.equal(
          f.shared.store.entries("studyTelegramTombstone:").length,
          0,
        );
        assert.equal(f.shared.counts().calls, 0);
        if (change === "credential") {
          await f.shared.db
            .prepare(
              "UPDATE credential_bindings SET subject=? WHERE binding_id=?",
            )
            .bind(f.session.wallet, f.session.binding_id)
            .run();
          for (
            let step = 0;
            step < 12 && !(await fixture.read())?.complete;
            step++
          ) {
            f.shared.advance(65_000);
            await fixture.recover();
            await f.factory.alarm();
          }
          const done = await fixture.read();
          assert.ok(done);
          assert.equal(done.complete, 1);
          assert.equal(done.transition_id, state.transition_id);
          assert.equal(done.request_json, state.request_json);
          assert.equal(f.shared.counts().calls, 0);
        }
      } finally {
        await f.dispose();
      }
    },
  );
