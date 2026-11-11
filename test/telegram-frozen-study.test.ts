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
import { studyPublicationFixtureV4 } from "./study-publication-fixture.ts";

test("a linked draft freezes its original grant before a lost operator response; website and different-grant retries cannot acquire it", async () => {
  const f = await studyPublicationFixtureV4(20171);
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
    const context = {
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
    const api = () =>
      frozenTelegramStudy(ports, session, "telegram-linked", context, f.db);
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
        { ...context, grantId: "fixture_grant_2" },
        f.db,
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
    const raced = await Promise.all(
      [raceAt, raceAt + 1].map((startedAt) =>
        frozenTelegramStudy(
          ports,
          session,
          "telegram-linked",
          {
            ...context,
            grantId: "fixture_race_grant",
            startedAt,
          },
          f.db,
        ).start(requestRace, f.song),
      ),
    );
    assert.equal(raced[0].lessonId, raced[1].lessonId);
    assert.equal(raced[0].startedAt, raced[1].startedAt);
    const raceRow = await store.byRequest(owner, requestRace);
    assert.ok(raceRow);
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
    await f.dispose();
  }
});
