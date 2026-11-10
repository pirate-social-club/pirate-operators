import { readFileSync } from "node:fs";
import { Effect } from "effect";
import type { DatabaseSync } from "node:sqlite";
import { makeStudyService } from "../services/study-spoken.ts";
import { makeStudyLessonService } from "../services/study-lessons.ts";
import { telegramLinkedStudy } from "../services/telegram-linked-study.ts";
import type { liveStudy } from "../services/study-community.ts";
import { actor, account } from "./telegram-fixture.ts";
import type { botFixture } from "./telegram-bot-fixture.ts";

/** Real SQLite statements behind the small D1 binding interface. The account
 * and operator-channel/authorization/ledger ports are explicit simulations;
 * production mounting and on-chain qualification are not inferred. */
export function d1Sqlite(database: DatabaseSync) {
  function prepare(
    sql: string,
    bindings: (string | number | null)[] = [],
  ): any {
    return {
      bind: (...values: (string | number | null)[]) => prepare(sql, values),
      async first(column?: string) {
        const row = database.prepare(sql).get(...bindings);
        return row ? (column ? row[column] : row) : null;
      },
      async all() {
        return {
          success: true,
          results: database.prepare(sql).all(...bindings),
          meta: {},
        };
      },
      async run() {
        const result = database.prepare(sql).run(...bindings);
        return {
          success: true,
          results: [],
          meta: {
            changes: Number(result.changes),
            last_row_id: Number(result.lastInsertRowid),
          },
        };
      },
    };
  }
  return {
    prepare,
    async batch(statements: { run(): Promise<unknown> }[]) {
      database.exec("SAVEPOINT d1_batch");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("RELEASE d1_batch");
        return results;
      } catch (error) {
        database.exec("ROLLBACK TO d1_batch");
        database.exec("RELEASE d1_batch");
        throw error;
      }
    },
  } as unknown as D1Database;
}
export async function linkedStudyFixture(
  f: Awaited<ReturnType<typeof botFixture>>,
) {
  f.database.exec(
    readFileSync(
      new URL("../packages/study/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  f.database.exec(
    "CREATE TABLE study_publications(lesson_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, community_id TEXT NOT NULL, binding_json TEXT NOT NULL)",
  );
  const db = d1Sqlite(f.database),
    lines = await f.catalog.lines(
      (await f.catalog.song(actor, "song-one", null)).song,
    );
  let calls = 0,
    lostResponse = false,
    bindChannel = "telegram-linked",
    fenceVersion = 1,
    authorityCalls = 0,
    publicationEntries = 0;
  const receipts = new Map<string, { text: string; language: string }>();
  const principal = {
    accountId: account.accountId,
    communityId: actor.communityId,
  };
  const attempts = makeStudyService({
    db,
    now: f.now,
    resolveLine: async (selection) =>
      lines.find((line) => line.lineId === selection.lineId)!,
    transcriber: {
      providerRetention: "stored",
      async transcribe(_audio, _type, _language, context) {
        calls++;
        const transcript = {
          text: lines.find((line) => line.lineId === context!.lineId)!.text,
          language: "en",
        };
        receipts.set(context!.attemptId, transcript);
        return transcript;
      },
      recover: async (context) =>
        receipts.has(context.attemptId)
          ? { state: "assessed", transcript: receipts.get(context.attemptId)! }
          : null,
    },
  });
  const lessons = makeStudyLessonService({
    db,
    attempts,
    resolveLines: async () => lines,
    now: f.now,
  });
  const adapter = telegramLinkedStudy({
    grants: f.grants,
    db,
    createStudy(session, channel, fence) {
      if (
        session.account_id !== principal.accountId ||
        session.wallet !== account.wallet ||
        channel !== "telegram-linked"
      )
        throw new Error("fixture_wrong_account_channel");
      return {
        telegramGrantFenceVersion: fenceVersion,
        latest: (song) => lessons.latest(principal, song),
        async start(requestId, song) {
          const lesson = await lessons.start(principal, requestId, song);
          await db
            .prepare("INSERT OR IGNORE INTO study_publications VALUES(?,?,?,?)")
            .bind(
              lesson.lessonId,
              principal.accountId,
              principal.communityId,
              JSON.stringify({ offer: { speechChannel: bindChannel } }),
            )
            .run();
          return lesson;
        },
        get: (id) => lessons.get(principal, id),
        open: (id, presentation, take) =>
          lessons.openAttempt(principal, id, presentation, take),
        async submit(id, attemptId, request) {
          await fence.check();
          const result = await Effect.runPromise(
            lessons.submit(principal, id, attemptId, request),
          );
          await fence.check();
          if (lostResponse) {
            lostResponse = false;
            throw new Error("simulated_linked_response_lost");
          }
          return result;
        },
      } as ReturnType<typeof liveStudy> & { telegramGrantFenceVersion: 1 };
    },
    async authorize(context, resolve) {
      authorityCalls++;
      const link = await resolve();
      if (
        !link ||
        link.accountId !== account.accountId ||
        context.startedAtMs < link.linkedAtMs
      )
        throw new Error("fixture_wrong_authorization");
      return { id: "0x" + "f".repeat(64) };
    },
    async personal(_actor, grant) {
      if (grant.accountId !== account.accountId)
        throw new Error("fixture_wrong_ledger_account");
      return {
        streak: 12,
        participation: publicationEntries ? "entered" : "none",
        claimable: false,
      };
    },
  });
  Object.assign(f.linked, adapter);
  return {
    db,
    lessons,
    attempts,
    adapter,
    principal,
    calls: () => calls,
    authorityCalls: () => authorityCalls,
    loseResponse: () => {
      lostResponse = true;
    },
    bindChannel: (value: string) => {
      bindChannel = value;
    },
    fenceVersion: (value: number) => {
      fenceVersion = value;
    },
    entries: () => publicationEntries,
  };
}
