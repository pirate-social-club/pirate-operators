import { digest } from "../packages/protocol/index.ts";
import { childKey } from "../services/telegram-transition-store.ts";
import type { TelegramDenialChild } from "../packages/telegram/transitions.ts";
// Repair3 regressions PREPARED, UNRUN. Actual current recovery/Telegram bridge,
// SQLite/D1 batches, issuer signing and request verification; mocked operator
// receipts only. These do not qualify D1 deployment or the migration runner.
import test from "node:test";
import assert from "node:assert/strict";
import { CommunityAuthorityPending } from "../packages/community-setup/authority-ledger.ts";
import { revalidateAuthorityMembers } from "../packages/community-setup/authority-validation.ts";
import { authorityOperation } from "../packages/community-setup/authority-ledger.ts";
import { revalidationFixture } from "./learning-authority-revalidation-fixture.ts";

async function drain(f: Awaited<ReturnType<typeof revalidationFixture>>) {
  for (let step = 0; step < 40; step++) {
    f.advance();
    try {
      if ((await f.resume()).complete) return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("status" in error) ||
        error.status !== 503
      )
        throw error;
    }
  }
  assert.fail("bounded valid sealed recovery did not finish");
}
function unchangedDelivery(
  f: Awaited<ReturnType<typeof revalidationFixture>>,
  before: ReturnType<typeof f.snapshot>,
) {
  const after = f.snapshot();
  assert.deepEqual(after.request, before.request);
  assert.deepEqual(after.operation, before.operation);
  assert.deepEqual(after.head, before.head);
  assert.deepEqual(after.members, before.members);
  assert.deepEqual(after.children, before.children);
  assert.equal(after.remote!.acknowledged, 0);
  assert.equal(after.remote!.complete, false);
  assert.equal(f.model.requests.length, 0);
  assert.equal(f.model.denials.size, 0);
  assert.equal(
    f.memory.sqlite
      .prepare(
        "SELECT complete FROM learning_authority_operations WHERE operation_id=?",
      )
      .get(f.op.operation_id)!.complete,
    0,
  );
}
for (const sealed of [true, false])
  test(
    `legacy59908a crosswired signed learner stays held through ${sealed ? "sealed" : "already-advanced"} recovery`,
    { timeout: 15000 },
    async () => {
      // Exactly50 rows with exhausted=false models a real full, advanced old page
      // whose next page is empty; the invalid original is now behind its cursor.
      const f = await revalidationFixture(sealed ? 1 : 50, true, sealed);
      try {
        const before = f.snapshot();
        await assert.rejects(f.resume(), CommunityAuthorityPending);
        unchangedDelivery(f, before);
        // Independent managed recovery must use the SAME required DB guard, not
        // assume authority-recovery reached its current-page validation earlier.
        f.advance();
        await f.recreate().recover();
        unchangedDelivery(f, before);
      } finally {
        f.closeAll();
      }
    },
  );
test(
  "valid sealed legacy membership revalidates in bounded durable pages before any send and survives service recreation",
  { timeout: 15000 },
  async () => {
    const f = await revalidationFixture(61);
    try {
      const before = f.snapshot(),
        op = (await authorityOperation(f.db, f.op.operation_id))!;
      assert.equal(await revalidateAuthorityMembers(f.db, op), false);
      const state = f.memory.sqlite
        .prepare(
          "SELECT cursor,complete FROM learning_authority_validation WHERE operation_id=?",
        )
        .get(op.operation_id)!;
      assert.equal(state.cursor, [...f.ids].sort()[49]);
      assert.equal(state.complete, 0);
      unchangedDelivery(f, before);
      // Check the actual bounded member query's plan rather than a Map iterator.
      const query = f.memory.responses.find(
        (r) => r.kind === "all" && r.sql.includes("AS member_id"),
      )!.sql;
      assert.match(query, /LIMIT 50/);
      const plan = f.memory.sqlite
        .prepare("EXPLAIN QUERY PLAN " + query)
        .all(op.operation_id, "");
      assert.ok(
        plan.some((row) => String(row.detail).includes("SEARCH m")),
        JSON.stringify(plan),
      );
      assert.ok(
        !plan.some((row) => String(row.detail).includes("TEMP B-TREE")),
        JSON.stringify(plan),
      );
      f.advance();
      await f.recreate().recover(); // Completes validation, delivers at most its bounded budget.
      await drain(f);
      assert.equal(f.model.denials.size, 61);
      assert.equal(f.model.requests.length, 61);
      assert.equal(
        f.journal.store.get<{ acknowledged: number; complete: boolean }>(
          "publication-transition:" + f.transitionId,
        )!.acknowledged,
        61,
      );
      assert.equal(
        f.journal.store.get<{ complete: boolean }>(
          "publication-transition:" + f.transitionId,
        )!.complete,
        true,
      );
      assert.deepEqual(f.snapshot().request, before.request);
    } finally {
      f.closeAll();
    }
  },
);
for (const changed of [false, true])
  test(
    `sealed provenance is invalidated by ${changed ? "changed" : "missing"} credential binding before resumed delivery`,
    { timeout: 15000 },
    async () => {
      const f = await revalidationFixture();
      try {
        assert.equal(
          await revalidateAuthorityMembers(
            f.db,
            (await authorityOperation(f.db, f.op.operation_id))!,
          ),
          true,
        );
        const before = f.snapshot();
        await f.db
          .prepare(
            changed
              ? "UPDATE credential_bindings SET account_id='b' WHERE binding_id='binding'"
              : "DELETE FROM credential_bindings WHERE binding_id='binding'",
          )
          .run();
        await assert.rejects(f.resume(), CommunityAuthorityPending);
        unchangedDelivery(f, before);
        f.advance();
        await f.recreate().recover();
        unchangedDelivery(f, before);
        // Restore fixture credential data only, retaining every original ID.
        if (changed)
          await f.db
            .prepare(
              "UPDATE credential_bindings SET account_id='a' WHERE binding_id='binding'",
            )
            .run();
        else
          await f.db
            .prepare(
              "INSERT INTO credential_bindings VALUES('binding','a','moss',6343,?,0)",
            )
            .bind(f.action.wallet)
            .run();
        await drain(f);
        assert.equal(f.model.requests.length, 1);
        assert.deepEqual(f.snapshot().request, before.request);
      } finally {
        f.closeAll();
      }
    },
  );
test(
  "credential change during a deferred validation read cannot advance stale provenance; retry restarts safely",
  { timeout: 15000 },
  async () => {
    const f = await revalidationFixture(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      const before = f.snapshot();
      let once = true;
      f.memory.afterResponse = async (response) => {
        if (
          once &&
          response.kind === "all" &&
          response.sql.includes("AS member_id")
        ) {
          once = false;
          entered.resolve();
          await release.promise;
        }
      };
      const running = f.resume();
      await entered.promise;
      await f.db
        .prepare(
          "UPDATE credential_bindings SET binding_id='binding-revision-2' WHERE binding_id='binding'",
        )
        .run();
      release.resolve();
      await assert.rejects(running, CommunityAuthorityPending);
      f.memory.afterResponse = undefined;
      const stale = f.memory.sqlite
        .prepare(
          "SELECT generation,cursor,complete FROM learning_authority_validation WHERE operation_id=?",
        )
        .get(f.op.operation_id)!;
      assert.equal(stale.cursor, "");
      assert.equal(stale.complete, 0);
      unchangedDelivery(f, before);
      await drain(f);
      const final = f.memory.sqlite
        .prepare(
          "SELECT generation,complete FROM learning_authority_validation WHERE operation_id=?",
        )
        .get(f.op.operation_id)!;
      assert.ok(Number(final.generation) > Number(stale.generation));
      assert.equal(final.complete, 1);
      assert.equal(f.model.requests.length, 1);
    } finally {
      release.resolve();
      f.memory.afterResponse = undefined;
      f.closeAll();
    }
  },
);
test(
  "lost validation-CAS response retains durable progress and retries without changing request or duplicating denial",
  { timeout: 15000 },
  async () => {
    const f = await revalidationFixture();
    try {
      const before = f.snapshot();
      let once = true;
      f.memory.afterResponse = (response) => {
        if (
          once &&
          response.kind === "run" &&
          response.sql.includes("UPDATE learning_authority_validation AS v")
        ) {
          once = false;
          throw Error("lost_validation_response");
        }
      };
      await assert.rejects(f.resume(), /lost_validation_response/);
      f.memory.afterResponse = undefined;
      assert.equal(
        f.memory.sqlite
          .prepare(
            "SELECT complete FROM learning_authority_validation WHERE operation_id=?",
          )
          .get(f.op.operation_id)!.complete,
        1,
      );
      unchangedDelivery(f, before);
      await drain(f);
      assert.equal(f.model.requests.length, 1);
      assert.deepEqual(f.snapshot().request, before.request);
    } finally {
      f.memory.afterResponse = undefined;
      f.closeAll();
    }
  },
);
test(
  "independent authority recovery without the required validator never sends retained denials",
  { timeout: 15000 },
  async () => {
    const f = await revalidationFixture();
    try {
      const before = f.snapshot();
      await f.model.publication.recover();
      unchangedDelivery(f, before);
    } finally {
      f.closeAll();
    }
  },
);

test(
  "a retained queued authorization denial outside validated membership cannot be sent or ACKed",
  { timeout: 15000 },
  async () => {
    const f = await revalidationFixture();
    try {
      const key = childKey(f.transitionId, 0),
        old = f.journal.store.get<TelegramDenialChild>(key)!;
      const denial = {
        schema: "pirate.study.telegram-publication-denial/1" as const,
        communityId: f.action.scope.communityId as `0x${string}`,
        kind: "authorization" as const,
        authorizationId: digest("unselected-original"),
      };
      f.journal.store.set(key, { ...old, denial, hash: digest(denial) });
      const before = f.snapshot();
      await assert.rejects(f.resume(), CommunityAuthorityPending);
      unchangedDelivery(f, before);
    } finally {
      f.closeAll();
    }
  },
);

test(
  "revalidation includes previously acknowledged frozen members before remaining delivery or sealed completion",
  { timeout: 15000 },
  async () => {
    const f = await revalidationFixture(2, true);
    try {
      const acknowledged = [...f.ids].sort().indexOf(f.ids[0]) + 1;
      // Retained old journal evidence only: preserve these ACKs, never clear them
      // or pretend the source repair reverses a prior external permanent effect.
      for (let index = 0; index < acknowledged; index++) {
        const key = childKey(f.transitionId, index),
          child = f.journal.store.get<TelegramDenialChild>(key)!;
        f.journal.store.set(key, { ...child, acknowledged: true });
      }
      const key = "publication-transition:" + f.transitionId,
        old = f.journal.store.get<Record<string, unknown>>(key)!;
      f.journal.store.set(key, { ...old, acknowledged, complete: false });
      const oldAck = digest({
        schema: "pirate.study.telegram-publication-denial/1",
        communityId: f.action.scope.communityId,
        kind: "authorization",
        authorizationId: f.ids[0],
      });
      await f.db
        .prepare(
          "UPDATE learning_authority_members SET acknowledgment=? WHERE operation_id=? AND authorization_id=?",
        )
        .bind(oldAck, f.op.operation_id, f.ids[0])
        .run();
      const before = f.snapshot();
      await assert.rejects(f.resume(), CommunityAuthorityPending);
      f.advance();
      await f.recreate().recover();
      const after = f.snapshot();
      assert.deepEqual(after.request, before.request);
      assert.deepEqual(after.operation, before.operation);
      assert.deepEqual(after.members, before.members);
      assert.deepEqual(after.children, before.children);
      assert.equal(after.remote!.acknowledged, acknowledged);
      assert.equal(after.remote!.complete, false);
      assert.equal(f.model.requests.length, 0);
      assert.equal(f.model.denials.size, 0);
    } finally {
      f.closeAll();
    }
  },
);
