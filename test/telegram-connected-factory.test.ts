import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../packages/protocol/index.ts";
import { telegramConnectedCommunity } from "../services/telegram-connected-community.ts";
import { connectedFactoryFixture } from "./telegram-connected-factory-fixture.ts";
import {
  connectedBoundary,
  requireFactoryGate,
} from "./telegram-factory-boundary.ts";

// UNRUN. Coordinator-only: merge exact held shared authority, account reader
// successor and protected adapters, then run in the serialized fixture slot.
test(
  "factory derives the real target/account/Study path, preserves the original lost speech result and never exports a capability marker",
  { timeout: 90000 },
  async () => {
    const f = await connectedFactoryFixture(20341);
    try {
      const { factory, options, shared, actor, session } = f;
      assert.equal("telegramGrantFenceVersion" in factory, false);
      assert.throws(
        () =>
          telegramConnectedCommunity({
            ...options,
            origin: "https://other.example",
          }),
        /telegram_community_origin_changed/,
      );
      assert.throws(
        () =>
          telegramConnectedCommunity({
            ...options,
            registration: {
              ...options.registration,
              communityId: "0x" + "f".repeat(64),
            },
          }),
        /telegram_study_target_changed/,
      );
      assert.throws(
        () =>
          telegramConnectedCommunity({
            ...options,
            study: {
              ...options.study,
              config: {
                ...options.study.config,
                learningRecords: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              },
            },
          }),
        /telegram_study_target_changed/,
      );
      assert.throws(
        () =>
          telegramConnectedCommunity({
            ...options,
            study: {
              ...options.study,
              env: { ...options.study.env, KARAOKE_PAYMENT_CHAIN_ID: "6343" },
            },
          }),
        /telegram_transition_target_changed/,
      );
      assert.throws(
        () =>
          telegramConnectedCommunity({
            ...options,
            storage: {
              ...options.storage,
              getAlarm: undefined,
            } as unknown as typeof options.storage,
          }),
        /telegram_durable_alarm_required/,
      );
      // Even an untyped mount cannot inject the former permissive construction hook.
      let bypassCalls = 0;
      Object.assign(options, {
        createLinkedStudy() {
          bypassCalls++;
          throw Error("fixture_bypass_used");
        },
      });
      f.restart();
      const status = await f.factory.routes(
        new Request(options.origin + "/api/telegram/connection", {
          headers: f.auth,
        }),
      );
      assert.equal(status.status, 200);
      assert.equal(
        ((await status.json()) as { grantId: string }).grantId,
        f.grant.id,
      );
      assert.equal(
        (
          await f.factory.routes(
            new Request(options.origin + "/api/telegram/notifications", {
              method: "PATCH",
              headers: {
                ...f.auth,
                origin: "https://other.example",
                "x-telegram-account": session.account_id,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                rewards: false,
                reminders: false,
                dance: false,
              }),
            }),
          )
        ).status,
        403,
      );
      assert.equal((await f.choose()).status, 200);
      await f.factory.alarm();
      const original = await shared.db
        .prepare(
          "SELECT l.lesson_id,l.started_at,l.state_json,p.binding_json FROM study_lessons l JOIN study_publications p USING(lesson_id) WHERE l.account_id=?",
        )
        .bind(session.account_id)
        .first<{
          lesson_id: string;
          started_at: number;
          state_json: string;
          binding_json: string;
        }>();
      assert.ok(
        original,
        JSON.stringify({
          ...(await connectedBoundary(f)),
          operatorResponses: f.operatorResponses,
        }),
      );
      const binding = JSON.parse(original.binding_json),
        state = JSON.parse(original.state_json);
      assert.equal(binding.offer.speechChannel, "telegram-linked");
      assert.equal(binding.offer.telegramFence.facts.grantId, f.grant.id);
      assert.equal(
        binding.offer.telegramFence.facts.accountId,
        session.account_id,
      );
      assert.deepEqual(binding.offer.telegramFence.facts.actor, actor);
      assert.equal(binding.offer.telegramFence.hash, state.telegram.fenceHash);
      assert.equal(
        binding.offer.authorizationId,
        state.telegram.authorizationId,
      );
      assert.equal(bypassCalls, 0);
      const secret =
        "private fixture voice should never cross persistent storage";
      f.forbidPersistedText(secret);
      shared.heard(secret);
      shared.lose("/study/speech");
      assert.equal((await f.voice()).status, 200);
      await f.factory.alarm();
      assert.equal(shared.counts().calls, 1);
      // Same durable SQLite journal; private result recovery uses actual status.
      f.restart();
      shared.advance(60_000);
      await f.factory.alarm();
      await f.factory.alarm();
      assert.equal(shared.counts().calls, 1);
      const recovered = await shared.db
        .prepare("SELECT state_json FROM study_lessons WHERE lesson_id=?")
        .bind(original.lesson_id)
        .first<{ state_json: string }>();
      assert.ok(recovered);
      const after = JSON.parse(recovered.state_json);
      assert.equal(after.presentationCount, 1);
      assert.equal(after.startedAt, original.started_at);
      assert.equal(
        after.telegram.authorizationId,
        state.telegram.authorizationId,
      );
      assert.equal(after.telegram.fenceHash, state.telegram.fenceHash);
      const grades = await shared.db
        .prepare("SELECT grade_json FROM study_attempts WHERE lesson_id=?")
        .bind(original.lesson_id)
        .all<{ grade_json: string | null }>();
      assert.equal(grades.results.length, 1);
      assert.doesNotMatch(
        grades.results.map((row) => row.grade_json ?? "").join("\n"),
        /heardTranscript|"transcript"|"matched"|"missing"/,
      );
      assert.ok(!JSON.stringify(f.journal.store.entries("")).includes(secret));
      assert.equal(bypassCalls, 0);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "real shared authority revision CAS denies an original start held across an awaited operator read",
  { timeout: 90000 },
  async () => {
    const f = await connectedFactoryFixture(20342);
    try {
      assert.equal((await f.choose()).status, 200);
      const wait = f.pause("/authorization/");
      const processing = f.factory.alarm();
      try {
        await requireFactoryGate(
          wait.entered,
          processing,
          "/authorization/",
          async () => ({
            ...(await connectedBoundary(f)),
            operatorResponses: f.operatorResponses,
          }),
        );
        await f.shared.db
          .prepare(
            "INSERT INTO learning_authority_heads(account_id,revision,permission_revision,pending_operation) VALUES(?,1,1,?) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1,permission_revision=permission_revision+1,pending_operation=excluded.pending_operation",
          )
          .bind(f.session.account_id, "fixture_pending_authority_0001")
          .run();
      } finally {
        wait.release();
      }
      await processing;
      assert.equal(f.shared.counts().calls, 0);
      assert.equal(
        await f.shared.db
          .prepare("SELECT 1 FROM study_publications WHERE account_id=?")
          .bind(f.session.account_id)
          .first(),
        null,
      );
      // Existing account reader must treat shared pending state as a hold. The
      // separately owned HTTP P2 repair must preserve this 503 instead of 401.
      const status = await f.factory.routes(
        new Request(f.options.origin + "/api/telegram/connection", {
          headers: f.auth,
        }),
      );
      assert.equal(status.status, 503);
      f.restart();
      await f.factory.alarm();
      assert.equal(f.shared.counts().calls, 0);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "actual signed scope denial recovers before readiness after a lost bind acknowledgement, outage and controller restart",
  { timeout: 90000 },
  async () => {
    const f = await connectedFactoryFixture(20343);
    try {
      assert.equal((await f.choose()).status, 200);
      const wait = f.pause("/study/bind");
      const processing = f.factory.alarm();
      try {
        await requireFactoryGate(
          wait.entered,
          processing,
          "/study/bind",
          async () => ({
            ...(await connectedBoundary(f)),
            operatorResponses: f.operatorResponses,
          }),
        );
        f.denialOffline(true);
        f.restart(2);
        await assert.rejects(f.factory.ready(), /telegram_publication_pending/);
      } finally {
        wait.release();
      }
      await processing;
      const old = f.journal.store.get<{ id: string; revokedAt: number | null }>(
        `grant:${f.actor.communityId}:${f.actor.botId}:${f.actor.userId}`,
      );
      assert.ok(old);
      assert.equal(f.shared.counts().calls, 0);
      assert.ok(f.factory.transitions.pending());
      assert.ok(f.alarm !== null);
      // No ordinary webhook can bypass the last-binding pending denial.
      assert.equal((await f.webhook({ update_id: 9000 })).status, 503);
      f.restart(2);
      f.denialOffline(false);
      f.shared.advance(60_000);
      await f.factory.alarm();
      await f.factory.ready();
      assert.equal(f.factory.transitions.pending(), false);
      await assert.rejects(
        f.factory.transitions.grants.assert(f.actor, f.grant.id),
      );
      const remote = f.shared.store.entries("studyTelegramTombstone:");
      // The operator's own denial record must exist, not a local readiness flag.
      assert.ok(
        remote.length,
        "real signed denial must be durably recorded by the operator",
      );
      assert.equal(
        f.shared.store.get(
          `studyTelegramTombstone:${digest({
            schema: "pirate.study.telegram-publication-denial/1",
            communityId: f.actor.communityId,
            kind: "scope",
            botId: f.actor.botId,
            generation: f.actor.generation,
          })}`,
        ),
        true,
      );
      assert.equal(f.shared.counts().calls, 0);
      assert.equal(old.id, f.grant.id);
      // Same-bot rotation denies the old publication scope, not the durable
      // account association. read() is not current chat authorization.
      const association = f.factory.transitions.grants.read({
        ...f.actor,
        generation: 2,
      });
      assert.ok(association);
      assert.equal(association.id, f.grant.id);
      assert.equal(association.revokedAt, null);
      assert.deepEqual(
        f.journal.store.get(
          `grant:${f.actor.communityId}:${f.actor.botId}:${f.actor.userId}`,
        ),
        f.grant,
      );
    } finally {
      await f.dispose();
    }
  },
);
