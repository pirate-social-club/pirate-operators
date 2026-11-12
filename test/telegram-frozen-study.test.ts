import { frozenLifecycleFixture } from "./telegram-frozen-lifecycle-fixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { accounts } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import type {
  TelegramStudyContext,
  TelegramStudyFence,
} from "../packages/study/telegram-publication.ts";
import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import {
  liveStudy,
  type StudyCommunityPorts,
} from "../services/study-community.ts";
import { frozenTelegramStudy } from "../services/telegram-frozen-study.ts";
import { studyBinding } from "../services/study-operator.ts";
import { LinkedWithdrawalPending } from "../services/study-linked-withdrawal-contract.ts";
import { studyPublicationFixtureV4 } from "./study-publication-fixture.ts";

test("a linked draft freezes its original grant before a lost operator response; website and different-grant retries cannot acquire it", async () => {
  const f = await studyPublicationFixtureV4(20171);
  const lifecycles: Awaited<ReturnType<typeof frozenLifecycleFixture>>[] = [];
  try {
    const wallet = accounts[5].address.toLowerCase();
    const row = await f.db
      .prepare(
        "SELECT b.account_id,a.authorization_id FROM credential_bindings b JOIN learning_authorizations a ON a.account_id=b.account_id WHERE b.namespace='moss' AND b.subject=? AND a.state='recorded' ORDER BY a.issued_at DESC LIMIT 1",
      )
      .bind(wallet)
      .first<{ account_id: string; authorization_id: Hex }>();
    assert.ok(row);
    let allowed = true;
    const authority = {
      async fetch(url: RequestInfo | URL, init?: RequestInit) {
        const input = (await new Request(url, init).json()) as {
          fence: TelegramStudyFence;
          context: TelegramStudyContext;
        };
        return Response.json({
          schema: "pirate.study.telegram-fence-observation/1",
          hash: input.fence.hash,
          contextHash: digest(input.context),
          allowed,
        });
      },
    } as Fetcher;
    f.env.STUDY_TELEGRAM_AUTHORITY = authority;
    f.operatorEnv.STUDY_TELEGRAM_AUTHORITY = authority;
    const ports: StudyCommunityPorts = {
      env: f.env,
      config: f.config,
      reads: f.ports.publicReads!,
      now: f.clock,
      db: f.db,
    };
    const session = { account_id: row.account_id, wallet };
    const seed = {
      version: 1 as const,
      grantId: "fixture_grant_1",
      accountId: row.account_id,
      actor: {
        communityId: f.config.communityId,
        botId: "90001",
        generation: 1,
        userId: "101",
        chatId: "101",
      },
      authorityVersion: "fixture_authority_1",
      authorizationId: row.authorization_id,
      startedAt: f.clock(),
      async check() {
        assert.ok(allowed, "fixture_link_unavailable");
      },
    };
    const first = await frozenLifecycleFixture(ports, session, seed);
    const different = await frozenLifecycleFixture(ports, session, {
      ...seed,
      grantId: "fixture_grant_2",
    });
    const race = await frozenLifecycleFixture(ports, session, {
      ...seed,
      grantId: "fixture_race_grant",
    });
    lifecycles.push(first, different, race);
    const context = first.context;
    const api = () =>
      frozenTelegramStudy(
        ports,
        session,
        "telegram-linked",
        context,
        f.db,
        first.publication,
      );
    const requestId = "fixture_linked_start_0001";
    f.lose("/study/bind");
    await assert.rejects(api().start(requestId, f.song));
    const store = new StudyLessonStore(f.db);
    const owner = {
      accountId: row.account_id,
      communityId: f.config.communityId,
    };
    const saved = await store.byRequest(owner, requestId);
    assert.ok(saved);
    const state = store.state(saved);
    assert.equal(state.telegram?.authorizationId, row.authorization_id);
    assert.equal(state.startedAt, context.startedAt);
    assert.equal(
      await f.db
        .prepare("SELECT 1 FROM study_publications WHERE lesson_id=?")
        .bind(saved.lesson_id)
        .first(),
      null,
    );
    assert.ok(studyBinding(f.store, saved.lesson_id));

    const website = liveStudy(ports, session);
    await assert.rejects(
      website.start(requestId, f.song),
      /study_lesson_channel_changed/,
    );
    await assert.rejects(
      website.get(saved.lesson_id),
      /study_lesson_channel_changed/,
    );
    await assert.rejects(
      website.open(saved.lesson_id, 1, 1),
      /study_lesson_channel_changed/,
    );
    await assert.rejects(
      frozenTelegramStudy(
        ports,
        session,
        "telegram-linked",
        different.context,
        f.db,
        different.publication,
      ).start(requestId, f.song),
      /study_lesson_channel_changed/,
    );
    f.advance(2000);
    const resumed = await api().start(requestId, f.song);
    assert.equal(resumed.lessonId, saved.lesson_id);
    assert.equal(resumed.startedAt, context.startedAt);
    const binding = studyBinding(f.store, saved.lesson_id)!;
    assert.equal(binding.offer.speechChannel, "telegram-linked");
    assert.equal(binding.offer.authorizationId, row.authorization_id);
    assert.equal(binding.offer.telegramFence?.hash, state.telegram?.fenceHash);
    assert.equal(await website.latest(f.song), null);
    assert.equal(
      (await api().get(resumed.lessonId)).lessonId,
      resumed.lessonId,
    );
    assert.equal(f.counts().calls, 0);
    assert.equal("telegramGrantFenceVersion" in api(), false);
    const raceAt = f.clock();
    f.advance(1);
    const requestRace = "fixture_linked_concurrent_0001";
    const raceContexts = [raceAt, raceAt + 1].map((startedAt) => ({
      ...race.context,
      startedAt,
    }));
    const startRace = (context: (typeof raceContexts)[number]) =>
      frozenTelegramStudy(
        ports,
        session,
        "telegram-linked",
        context,
        f.db,
        race.publication,
      ).start(requestRace, f.song);
    // Keep both starts concurrent. A binding commit can advance bootstrap
    // after the other call captured it but before that call commits.
    const outcomes = await Promise.allSettled(raceContexts.map(startRace));
    const pending = outcomes.flatMap((outcome, index) => {
      if (outcome.status === "fulfilled") return [];
      assert.ok(outcome.reason instanceof LinkedWithdrawalPending);
      assert.equal(outcome.reason.message, "study_linked_withdrawal_pending");
      assert.equal(outcome.reason.status, 503);
      assert.equal(outcome.reason.retryable, true);
      return [index];
    });
    // Serialized interleavings may succeed twice; two rejected starts fail.
    assert.ok(pending.length <= 1);
    const originalRaceRow = await store.byRequest(owner, requestRace);
    assert.ok(originalRaceRow);
    const originalRaceState = store.state(originalRaceRow);
    const originalRaceBinding = studyBinding(
      f.store,
      originalRaceRow.lesson_id,
    );
    assert.ok(originalRaceBinding);
    const originalBindingBytes = JSON.stringify(originalRaceBinding);
    const publicationBytes = () =>
      f.db
        .prepare(
          "SELECT binding_json FROM study_publications WHERE lesson_id=?",
        )
        .bind(originalRaceRow.lesson_id)
        .first<{ binding_json: string }>();
    const originalPublication = await publicationBytes();
    assert.ok(originalPublication);
    assert.equal(
      originalRaceState.telegram?.authorizationId,
      row.authorization_id,
    );
    assert.equal(originalRaceBinding.authorization?.id, row.authorization_id);
    assert.equal(originalRaceBinding.offer.speechChannel, "telegram-linked");
    assert.equal(
      originalRaceBinding.offer.telegramFence?.facts.grantId,
      race.context.grantId,
    );
    assert.deepEqual(
      originalRaceBinding.offer.telegramFence?.facts.actor,
      race.context.actor,
    );
    assert.equal(
      originalRaceBinding.offer.telegramFence?.facts.accountId,
      race.context.accountId,
    );
    assert.equal(
      originalRaceBinding.offer.telegramFence?.facts.authorityVersion,
      race.context.authorityVersion,
    );
    assert.equal(
      originalRaceBinding.offer.telegramFence?.hash,
      originalRaceState.telegram?.fenceHash,
    );
    assert.equal(
      originalRaceBinding.offer.startedAt,
      originalRaceState.startedAt,
    );
    assert.ok(
      raceContexts.some(
        ({ startedAt }) => startedAt === originalRaceState.startedAt,
      ),
    );
    const snapshotWork = async () => ({
      operator: f.store.entries(""),
      provider: f.counts(),
      rows: await Promise.all(
        ["study_lessons", "study_attempts", "study_publications"].map((table) =>
          f.db
            .prepare(
              `SELECT count(*) AS count FROM ${table} WHERE account_id=? AND community_id=?`,
            )
            .bind(owner.accountId, owner.communityId)
            .first<{ count: number }>(),
        ),
      ),
    });
    const beforeRecovery = await snapshotWork();
    const raced = outcomes.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value : undefined,
    );
    if (pending.length === 1) {
      const index = pending[0];
      // One explicit recovery after the winner has settled, using the exact
      // losing context/request/grant. Never retry any other error or retime.
      raced[index] = await startRace(raceContexts[index]);
    }
    assert.ok(raced[0]);
    assert.ok(raced[1]);
    assert.equal(raced[0].lessonId, raced[1].lessonId);
    assert.equal(raced[0].startedAt, raced[1].startedAt);
    const raceRow = await store.byRequest(owner, requestRace);
    assert.ok(raceRow);
    assert.equal(raced[0].lessonId, originalRaceRow.lesson_id);
    assert.equal(raced[0].startedAt, originalRaceState.startedAt);
    assert.deepEqual(raceRow, originalRaceRow);
    assert.equal(
      JSON.stringify(studyBinding(f.store, raceRow.lesson_id)),
      originalBindingBytes,
    );
    assert.deepEqual(await publicationBytes(), originalPublication);
    assert.deepEqual(await snapshotWork(), beforeRecovery);
    assert.deepEqual(
      raceContexts.map(({ startedAt }) => startedAt),
      [raceAt, raceAt + 1],
    );
    assert.equal(
      studyBinding(f.store, raceRow.lesson_id)?.offer.startedAt,
      raced[0].startedAt,
    );
    assert.equal(f.counts().calls, 0);
    allowed = false;
    await assert.rejects(
      api().get(resumed.lessonId),
      /fixture_link_unavailable/,
    );
    assert.equal(f.counts().calls, 0);
    await assert.rejects(
      store.update(owner, (await store.byRequest(owner, requestId))!, {
        ...state,
        telegram: undefined,
      }),
      /study_lesson_channel_changed/,
    );
  } finally {
    for (const lifecycle of lifecycles) lifecycle.close();
    await f.dispose();
  }
});
