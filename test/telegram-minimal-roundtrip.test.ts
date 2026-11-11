import test from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { accounts } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import type {
  TelegramStudyContext,
  TelegramStudyFence,
} from "../packages/study/telegram-publication.ts";
import { frozenTelegramStudy } from "../services/telegram-frozen-study.ts";
import { studyPublicationFixtureV4 } from "./study-publication-fixture.ts";

test("actual V4 linked speech recovers a lost reply using a minimal operator receipt, with no raw D1/operator write or redispatch", async () => {
  const f = await studyPublicationFixtureV4(20173);
  try {
    const wallet = accounts[5].address.toLowerCase();
    const row = await f.db
      .prepare(
        "SELECT b.account_id,a.authorization_id FROM credential_bindings b JOIN learning_authorizations a ON a.account_id=b.account_id WHERE b.namespace='moss' AND b.subject=? AND a.state='recorded' ORDER BY a.issued_at DESC LIMIT 1",
      )
      .bind(wallet)
      .first<{ account_id: string; authorization_id: Hex }>();
    assert.ok(row);
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
          allowed: true,
        });
      },
    } as Fetcher;
    f.env.STUDY_TELEGRAM_AUTHORITY = authority;
    f.operatorEnv.STUDY_TELEGRAM_AUTHORITY = authority;
    const secret = "private linked voice content must never be stored";
    const set = f.store.set;
    f.store.set = (key, value) => {
      assert.ok(
        !JSON.stringify(value).includes(secret),
        "raw private content crossed the operator storage boundary",
      );
      set(key, value);
    };
    const checkedDb = new Proxy(f.db, {
      get(db, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = db.prepare(sql);
            if (!/UPDATE study_attempts SET state=\?,grade_json=\?/i.test(sql))
              return statement;
            return new Proxy(statement, {
              get(prepared, field) {
                if (field === "bind")
                  return (...args: unknown[]) => {
                    assert.ok(
                      !JSON.stringify(args[1]).includes(secret),
                      "raw private content crossed the D1 binding boundary",
                    );
                    return prepared.bind(...args);
                  };
                const value = Reflect.get(prepared, field);
                return typeof value === "function"
                  ? value.bind(prepared)
                  : value;
              },
            });
          };
        const value = Reflect.get(db, key);
        return typeof value === "function" ? value.bind(db) : value;
      },
    });
    const api = frozenTelegramStudy(
      {
        env: f.env,
        config: f.config,
        reads: f.ports.publicReads!,
        now: f.clock,
      },
      { account_id: row.account_id, wallet },
      "telegram-linked",
      {
        version: 1,
        grantId: "fixture_private_grant",
        accountId: row.account_id,
        actor: {
          communityId: f.config.communityId,
          botId: "90001",
          generation: 1,
          userId: "101",
          chatId: "101",
        },
        authorityVersion: "fixture_private_authority",
        authorizationId: row.authorization_id,
        startedAt: f.clock(),
        async check() {},
      },
      checkedDb,
    );
    const lesson = await api.start("fixture_private_roundtrip_0001", f.song);
    const opened = await api.open(lesson.lessonId, 1, 1);
    f.heard(secret);
    f.lose("/study/speech");
    const first = await api.submit(
      lesson.lessonId,
      opened.attempt.attemptId,
      new Request("https://fixture.example/audio", {
        method: "PUT",
        headers: {
          "content-type": "audio/webm",
          "x-study-duration-ms": "1000",
        },
        body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 1]),
      }),
    );
    assert.equal(first.attempt.state, "uncertain");
    assert.equal(f.counts().calls, 1);
    const recovered = await api.get(lesson.lessonId);
    assert.equal(recovered.progress.presentations, 1);
    await api.get(lesson.lessonId);
    assert.equal(f.counts().calls, 1);
    const saved = await f.db
      .prepare("SELECT grade_json FROM study_attempts WHERE attempt_id=?")
      .bind(opened.attempt.attemptId)
      .first<{ grade_json: string }>();
    assert.ok(saved);
    assert.doesNotMatch(
      saved.grade_json,
      /heardTranscript|"transcript"|"matched"|"missing"/,
    );
    for (const record of f.store.entries("studySpeech:"))
      assert.doesNotMatch(
        JSON.stringify(record.value),
        /heardTranscript|"transcript"|"matched"|"missing"/,
      );
    assert.equal("telegramGrantFenceVersion" in api, false);
  } finally {
    await f.dispose();
  }
});
