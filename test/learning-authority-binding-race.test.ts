// Repair4 deterministic cases PREPARED/UNRUN. Actual DB validator and managed
// post-signing guard; mocked operator Fetcher only. No existing witness changed.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CommunityAuthorityPending,
  authorityOperation,
} from "../packages/community-setup/authority-ledger.ts";
import {
  AUTHORITY_VALIDATION_POLICY,
  requireAuthorityValidation,
  revalidateAuthorityMembers,
} from "../packages/community-setup/authority-validation.ts";
import { childKey } from "../services/telegram-transition-store.ts";
import type { TelegramDenialChild } from "../packages/telegram/transitions.ts";
import {
  bindingRaceFixture,
  walletRead,
  revision,
  validation,
  reassign,
  noFetchOrAck,
  drain,
  seedPolicy1,
} from "./learning-authority-binding-race-fixture.ts";
import { revalidationFixture } from "./learning-authority-revalidation-fixture.ts";

for (const aba of [false, true])
  test(
    `empty sealed grant delivery rejects ${aba ? "ABA" : "reassignment"} exactly after wallet lookup and before upsert`,
    { timeout: 15000 },
    async () => {
      const f = await bindingRaceFixture(),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      try {
        const before = f.snapshot(),
          captured = revision(f),
          binding = f.memory.sqlite
            .prepare(
              "SELECT * FROM credential_bindings WHERE binding_id='binding'",
            )
            .get()!;
        assert.equal(before.members.length, 0);
        assert.equal(before.children.length, 1);
        let once = true;
        f.memory.afterResponse = async ({ kind, sql }) => {
          if (once && walletRead(kind, sql)) {
            once = false;
            entered.resolve();
            await release.promise;
          }
        };
        const running = f.recreate().recover();
        await entered.promise;
        const reads = f.memory.responses,
          lookup = reads.findIndex((r) => walletRead(r.kind, r.sql));
        assert.ok(
          reads
            .slice(0, lookup)
            .some(
              (r) =>
                r.kind === "first" && r.sql.includes("AS captured_revision"),
            ),
          "revision capture must precede the wallet lookup",
        );
        await reassign(f, aba);
        assert.ok(revision(f) > captured);
        if (aba)
          assert.deepEqual(
            f.memory.sqlite
              .prepare(
                "SELECT * FROM credential_bindings WHERE binding_id='binding'",
              )
              .get(),
            binding,
          );
        release.resolve();
        await running;
        f.memory.afterResponse = undefined;
        noFetchOrAck(f, before);
        assert.equal(
          validation(f),
          undefined,
          "a changed revision cannot be inserted as newly validated",
        );
        if (aba) {
          await drain(f);
          assert.equal(validation(f)!.credential_revision, revision(f));
          assert.equal(f.model.requests.length, 1);
        }
      } finally {
        release.resolve();
        f.memory.afterResponse = undefined;
        f.closeAll();
      }
    },
  );

test(
  "stable empty sealed captured-grant recovery certifies and delivers once using policy2",
  { timeout: 15000 },
  async () => {
    const f = await bindingRaceFixture();
    try {
      const before = f.snapshot(),
        captured = revision(f);
      await drain(f);
      const state = validation(f)!;
      assert.equal(state.policy, AUTHORITY_VALIDATION_POLICY);
      assert.equal(state.credential_revision, captured);
      assert.equal(state.complete, 1);
      assert.equal(f.model.requests.length, 1);
      assert.equal(f.model.denials.size, 1);
      assert.deepEqual(f.model.denials.values().next().value, {
        schema: "pirate.study.telegram-publication-denial/1",
        communityId: f.action.scope.communityId,
        kind: "grant",
        botId: f.action.scope.botId,
        grantId: f.grant.id,
      });
      assert.equal(f.snapshot().remote!.acknowledged, 1);
      assert.equal(f.snapshot().remote!.complete, true);
      assert.equal(
        f.snapshot().request!.request_json,
        before.request!.request_json,
      );
    } finally {
      f.closeAll();
    }
  },
);

test(
  "a stale upsert caller cannot adopt or overwrite a newer completed credential witness",
  { timeout: 15000 },
  async () => {
    const f = await bindingRaceFixture(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      const before = f.snapshot();
      let once = true;
      f.memory.afterResponse = async ({ kind, sql }) => {
        if (
          once &&
          kind === "run" &&
          sql.includes("INSERT INTO learning_authority_validation")
        ) {
          once = false;
          entered.resolve();
          await release.promise;
        }
      };
      const running = f.recreate().recover();
      await entered.promise;
      await reassign(f, true);
      assert.equal(
        await revalidateAuthorityMembers(
          f.db,
          (await authorityOperation(f.db, f.op.operation_id))!,
        ),
        true,
      );
      const newer = validation(f)!;
      assert.equal(newer.credential_revision, revision(f));
      release.resolve();
      await running;
      f.memory.afterResponse = undefined;
      noFetchOrAck(f, before);
      assert.deepEqual(validation(f), newer);
      await drain(f);
      assert.equal(f.model.requests.length, 1);
    } finally {
      release.resolve();
      f.memory.afterResponse = undefined;
      f.closeAll();
    }
  },
);

test(
  "final pre-fetch validation retains the original revision even when a concurrent ABA retry completes",
  { timeout: 15000 },
  async () => {
    const f = await bindingRaceFixture(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      assert.equal(
        await revalidateAuthorityMembers(
          f.db,
          (await authorityOperation(f.db, f.op.operation_id))!,
        ),
        true,
      );
      const before = f.snapshot(),
        oldRevision = revision(f);
      let once = true;
      f.memory.afterResponse = async ({ kind, sql }) => {
        if (
          once &&
          kind === "first" &&
          sql.includes("FROM learning_authority_validation v WHERE") &&
          sql.includes("v.complete=1")
        ) {
          once = false;
          entered.resolve();
          await release.promise;
        }
      };
      const running = f.recreate().recover();
      await entered.promise;
      await reassign(f, true);
      assert.ok(revision(f) > oldRevision);
      assert.equal(
        await revalidateAuthorityMembers(
          f.db,
          (await authorityOperation(f.db, f.op.operation_id))!,
        ),
        true,
      );
      const newer = validation(f)!;
      release.resolve();
      await running;
      f.memory.afterResponse = undefined;
      noFetchOrAck(f, before);
      assert.deepEqual(validation(f), newer);
      await drain(f);
      assert.equal(f.model.requests.length, 1);
    } finally {
      release.resolve();
      f.memory.afterResponse = undefined;
      f.closeAll();
    }
  },
);

test(
  "policy1 completion is never grandfathered for a now-invalid captured wallet",
  { timeout: 15000 },
  async () => {
    const f = await bindingRaceFixture();
    try {
      await reassign(f);
      await seedPolicy1(f);
      const old = validation(f)!;
      await assert.rejects(
        requireAuthorityValidation(
          f.db,
          (await authorityOperation(f.db, f.op.operation_id))!,
        ),
        CommunityAuthorityPending,
      );
      const before = f.snapshot();
      await f.recreate().recover();
      noFetchOrAck(f, before);
      assert.deepEqual(validation(f), old);
    } finally {
      f.closeAll();
    }
  },
);

test(
  "retained grant ACK and old completion survive blocked restart without fetch or ACK replacement",
  { timeout: 15000 },
  async () => {
    const f = await bindingRaceFixture();
    try {
      await reassign(f);
      await seedPolicy1(f);
      const key = childKey(f.transitionId, 0),
        child = f.journal.store.get<TelegramDenialChild>(key)!;
      f.journal.store.set(key, { ...child, acknowledged: true });
      const opKey = "publication-transition:" + f.transitionId,
        remote = f.journal.store.get<Record<string, unknown>>(opKey)!;
      f.journal.store.set(opKey, {
        ...remote,
        acknowledged: 1,
        complete: false,
      });
      const before = f.snapshot();
      await f.recreate().recover();
      noFetchOrAck(f, before);
      await f.db
        .prepare(
          "UPDATE credential_bindings SET account_id='a' WHERE binding_id='binding'",
        )
        .run();
      await drain(f);
      assert.equal(f.model.requests.length, 0);
      assert.deepEqual(f.snapshot().children, before.children);
      assert.equal(validation(f)!.policy, AUTHORITY_VALIDATION_POLICY);
    } finally {
      f.closeAll();
    }
  },
);

test(
  "persisted policy1 cursor/completion is rescanned in bounded pages without repeating retained ACKs",
  { timeout: 15000 },
  async () => {
    const f = await revalidationFixture(61);
    try {
      const ids = [...f.ids].sort(),
        acknowledged = 5;
      for (let index = 0; index < acknowledged; index++) {
        const key = childKey(f.transitionId, index),
          child = f.journal.store.get<TelegramDenialChild>(key)!;
        f.journal.store.set(key, { ...child, acknowledged: true });
        await f.db
          .prepare(
            "UPDATE learning_authority_members SET acknowledgment=? WHERE operation_id=? AND authorization_id=?",
          )
          .bind(child.hash, f.op.operation_id, ids[index])
          .run();
      }
      const key = "publication-transition:" + f.transitionId,
        remote = f.journal.store.get<Record<string, unknown>>(key)!;
      f.journal.store.set(key, { ...remote, acknowledged, complete: false });
      await seedPolicy1(f, 1, ids.at(-1)!);
      const before = f.snapshot();
      await f.recreate().recover();
      const partial = validation(f)!;
      assert.equal(partial.policy, AUTHORITY_VALIDATION_POLICY);
      assert.equal(partial.complete, 0);
      assert.equal(partial.cursor, ids[49]);
      assert.ok(Number(partial.generation) > 7);
      noFetchOrAck(f, before);
      await drain(f);
      assert.equal(f.model.requests.length, 61 - acknowledged);
      for (let index = 0; index < acknowledged; index++)
        assert.deepEqual(f.snapshot().children[index], before.children[index]);
      assert.equal(validation(f)!.complete, 1);
    } finally {
      f.closeAll();
    }
  },
);
