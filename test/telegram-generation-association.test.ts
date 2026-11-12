import test from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { digest } from "../packages/protocol/index.ts";
import { address, chain } from "../packages/community/manifest-core.ts";
import {
  bindManagedStudy,
  type StudyOperatorPorts,
} from "../services/study-operator-client.ts";
import type { StudyAuthorizationBinding } from "../services/study-authorization.ts";
import { connectedFactoryFixture } from "./telegram-connected-factory-fixture.ts";

interface OriginalRow {
  lesson_id: string;
  request_id: string;
  started_at: number;
  state_json: string;
  binding_json: string;
}

// UNRUN successor. Contract provenance at exact93eb: telegram-repair1.md,
// telegram-source-handoff.md and the existing same-bot linking regression.
// Uses real factory, native webhook, account checks, SQL and signed operator.
test(
  "same-bot generation requires fresh chat readiness and permits prospective Study without reviving the denied original",
  { timeout: 90000 },
  async () => {
    const f = await connectedFactoryFixture(20360);
    try {
      const rows = async () =>
        (
          await f.shared.db
            .prepare(
              "SELECT l.lesson_id,l.request_id,l.started_at,l.state_json,p.binding_json FROM study_lessons l JOIN study_publications p USING(lesson_id) WHERE l.account_id=? ORDER BY l.lesson_id",
            )
            .bind(f.session.account_id)
            .all<OriginalRow>()
        ).results;
      assert.equal((await f.choose()).status, 200);
      await f.factory.alarm();
      const before = await rows();
      assert.equal(before.length, 1);
      const original = before[0];
      const oldBinding = JSON.parse(
        original.binding_json,
      ) as StudyAuthorizationBinding;
      assert.equal(oldBinding.offer.telegramFence?.facts.actor.generation, 1);
      const originalOperator = f.shared.store.get<StudyAuthorizationBinding>(
        "studyBinding:" + original.lesson_id,
      );
      assert.ok(originalOperator);
      assert.deepEqual(originalOperator, oldBinding);
      const originalOperatorHash = digest(originalOperator);
      const grantKey = `grant:${f.actor.communityId}:${f.actor.botId}:${f.actor.userId}`;
      const originalGrant = f.journal.store.get<typeof f.grant>(grantKey);
      assert.ok(originalGrant);
      assert.equal(originalGrant.id, f.grant.id);

      f.shared.advance(60_000);
      f.restart(2);
      await f.factory.ready();
      assert.equal(f.factory.transitions.pending(), false);
      const grants = f.factory.transitions.grants;
      const rotated = { ...f.actor, generation: 2 };
      const denialKey =
        "studyTelegramTombstone:" +
        digest({
          schema: "pirate.study.telegram-publication-denial/1",
          communityId: f.actor.communityId,
          kind: "scope",
          botId: f.actor.botId,
          generation: 1,
        });
      assert.equal(f.shared.store.get(denialKey), true);
      await assert.rejects(
        grants.assert(f.actor, f.grant.id),
        /telegram_bot_changed/,
      );
      assert.deepEqual(grants.read(rotated), originalGrant);
      assert.equal(
        grants.forAccount(rotated, f.session.account_id)?.id,
        originalGrant.id,
      );
      // Neither raw lookup nor the account index proves current chat readiness.
      await assert.rejects(
        grants.assert(rotated, f.grant.id),
        /telegram_start_required/,
      );
      assert.deepEqual(await rows(), before);

      // choose() first sends the actual native /start to the CURRENT factory,
      // then queues a song callback. The account/grant is not re-created.
      assert.equal((await f.choose()).status, 200);
      assert.equal(grants.binding(rotated).generation, 2);
      const current = await grants.assert(rotated, f.grant.id);
      assert.equal(current.id, originalGrant.id);
      assert.equal(current.accountId, f.session.account_id);
      assert.equal(current.wallet, f.session.wallet);
      await assert.rejects(
        grants.assert(f.actor, f.grant.id),
        /telegram_bot_changed/,
      );

      const env = f.options.study.env;
      const ports: StudyOperatorPorts = {
        binding: env.KARAOKE_OPERATOR!,
        issuerKey: env.KARAOKE_SIGNER_PRIVATE_KEY as Hex,
        now: f.shared.clock,
        authority: {
          chainId: chain(Number(env.KARAOKE_PAYMENT_CHAIN_ID)),
          communityId: f.shared.config.communityId,
          operator: address(env.KARAOKE_OPERATOR_ADDRESS?.toLowerCase()),
          contract: address(f.shared.config.learningRecords),
        },
      };
      // A current associated account still cannot re-bind its exact original
      // generation-1 offer. The real signed route enforces the scope tombstone.
      await assert.rejects(
        bindManagedStudy(ports, originalOperator.offer),
        /study_telegram_grant_withdrawn/,
      );
      assert.equal(
        digest(f.shared.store.get("studyBinding:" + original.lesson_id)),
        originalOperatorHash,
      );
      assert.deepEqual(await rows(), before);

      await f.factory.alarm();
      const after = await rows();
      assert.equal(after.length, 2);
      assert.deepEqual(
        after.find((row) => row.lesson_id === original.lesson_id),
        original,
      );
      const prospective = after.find(
        (row) => row.lesson_id !== original.lesson_id,
      );
      assert.ok(prospective);
      const prospectiveBinding = JSON.parse(
        prospective.binding_json,
      ) as StudyAuthorizationBinding;
      assert.deepEqual(
        prospectiveBinding.offer.telegramFence?.facts.actor,
        rotated,
      );
      assert.equal(
        prospectiveBinding.offer.telegramFence?.facts.grantId,
        originalGrant.id,
      );
      assert.equal(
        prospectiveBinding.offer.authorizationId,
        oldBinding.offer.authorizationId,
      );
      assert.notEqual(
        prospectiveBinding.offer.telegramFence?.hash,
        oldBinding.offer.telegramFence?.hash,
      );
      assert.notEqual(prospective.request_id, original.request_id);
      assert.ok(prospective.started_at > original.started_at);
      assert.deepEqual(f.journal.store.get(grantKey), originalGrant);
      assert.equal(f.shared.store.get(denialKey), true);
      await assert.rejects(
        bindManagedStudy(ports, originalOperator.offer),
        /study_telegram_grant_withdrawn/,
      );
      assert.equal(
        digest(f.shared.store.get("studyBinding:" + original.lesson_id)),
        originalOperatorHash,
      );
      assert.deepEqual(
        (await rows()).find((row) => row.lesson_id === original.lesson_id),
        original,
      );
      assert.equal(f.shared.counts().calls, 0);
      assert.equal(f.shared.store.entries("studyPublication:").length, 0);
      assert.equal(
        (
          await f.shared.db
            .prepare(
              "SELECT count(*) AS n FROM study_attempts WHERE account_id=?",
            )
            .bind(f.session.account_id)
            .first<{ n: number }>()
        )?.n,
        0,
      );
    } finally {
      await f.dispose();
    }
  },
);
