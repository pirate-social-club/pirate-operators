import test from "node:test";
import assert from "node:assert/strict";
import { studyPublicationFixture } from "./study-publication-fixture.ts";
import { communityScheduled } from "../services/community-application.ts";
import { deleteExpiredStudyHistory } from "../services/study-retention.ts";
import { STUDY_HISTORY_EXPORT_WINDOW_MS } from "../services/study-history.ts";

async function postingQueueOutage(
  f: Awaited<ReturnType<typeof studyPublicationFixture>>,
  lessonId: string,
) {
  // Synthetic unrelated posting work, using the actual migrated D1 tables.
  await f.db.batch([
    f.db
      .prepare(
        `INSERT INTO media_submissions(submission_id,account_id,author_id,post_id,idempotency_key,request_hash,metadata_json,captured_wallet,creator_json,audio_sha256,audio_bytes,object_key,upload_state,created_at)
      SELECT 'retention-probe-submission',account_id,'fixture-author','fixture-post','fixture-request','fixture-hash','{}','fixture-wallet','{}','fixture-sha',1,'fixture-retention-object','reserved',0
      FROM study_lessons WHERE lesson_id=?`,
      )
      .bind(lessonId),
    f.db
      .prepare(`INSERT INTO publication_jobs(job_id,submission_id,input_hash,authority_json,phase,due_at,created_at,updated_at)
      VALUES('retention-probe-job','retention-probe-submission','fixture-hash','{}','uncertain',0,0,0)`),
  ]);
  f.env.JOBS = {
    send: async () => {
      throw Error("fixture queue unavailable");
    },
  } as never;
}

test(
  "an unrelated publication queue outage cannot suppress private retention",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19887);
    try {
      const lesson = await f.start();
      await postingQueueOutage(f, lesson.lessonId);
      f.advance(lesson.expiresAt + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock());
      f.env.STUDY_RESULTS_V3_CONTRACT = undefined;
      await assert.rejects(
        communityScheduled(f.env, f.ports),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 1);
          assert.match(error.errors[0].message, /fixture queue unavailable/);
          return true;
        },
      );
      const saved = await f.db
        .prepare(
          "SELECT history_deleted_at FROM study_lessons WHERE lesson_id=?",
        )
        .bind(lesson.lessonId)
        .first<{ history_deleted_at: number | null }>();
      assert.equal(saved!.history_deleted_at, f.clock());
      assert.deepEqual(f.counts(), { calls: 0, observations: 0 });
    } finally {
      await f.dispose();
    }
  },
);

test(
  "retention and posting errors cannot suppress independent public outbox recovery",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19888);
    try {
      const invalid = await f.start();
      await f.db
        .prepare(
          "UPDATE study_lessons SET state_json=json_set(state_json,'$.policy','fixture-invalid') WHERE lesson_id=?",
        )
        .bind(invalid.lessonId)
        .run();
      f.advance(1);
      let valid = await f.start();
      valid = (await f.answer(valid, false)).lesson;
      f.lose("/study/terminal");
      await f.abandon(valid.lessonId);
      await postingQueueOutage(f, valid.lessonId);
      const counts = f.counts(),
        txCount = f.store.entries("tx:").length,
        ledger = f.store.get("sponsor:ledger");
      f.advance(invalid.expiresAt + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock());
      await f.evm.rpc("anvil_mine", ["0xc"]);
      await assert.rejects(
        communityScheduled(f.env, f.ports),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.ok(
            error.errors.some((item) =>
              /study_lesson_policy_unavailable/.test(item.message),
            ),
          );
          assert.ok(
            error.errors.some((item) =>
              /fixture queue unavailable/.test(item.message),
            ),
          );
          return true;
        },
      );
      const saved = await f.db
        .prepare(
          "SELECT state,receipt_json FROM study_publications WHERE lesson_id=?",
        )
        .bind(valid.lessonId)
        .first<{ state: string; receipt_json: string }>();
      assert.equal(saved!.state, "published");
      assert.equal(JSON.parse(saved!.receipt_json).confirmed, true);
      assert.deepEqual(f.counts(), counts);
      assert.equal(f.store.entries("tx:").length, txCount);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "invalid rows filling a bounded scan cannot starve a later valid lesson",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19889);
    try {
      for (let i = 0; i < 2; i++) {
        const invalid = await f.start();
        await f.db
          .prepare(
            "UPDATE study_lessons SET state_json=json_set(state_json,'$.policy','fixture-invalid') WHERE lesson_id=?",
          )
          .bind(invalid.lessonId)
          .run();
        f.advance(1);
      }
      const valid = await f.start();
      f.advance(valid.expiresAt + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock());
      await assert.rejects(
        deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock, 2),
      );
      await assert.rejects(
        deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock, 2),
      );
      const rows = await f.db
        .prepare(
          "SELECT lesson_id,history_deleted_at,state_json,revision FROM study_lessons",
        )
        .all<{
          lesson_id: string;
          history_deleted_at: number | null;
          state_json: string;
          revision: number;
        }>();
      assert.equal(
        rows.results.find((row) => row.lesson_id === valid.lessonId)!
          .history_deleted_at,
        f.clock(),
      );
      for (const row of rows.results.filter(
        (row) => row.lesson_id !== valid.lessonId,
      )) {
        assert.equal(row.history_deleted_at, null);
        assert.equal(JSON.parse(row.state_json).policy, "fixture-invalid");
        assert.equal(row.revision, 0);
      }
      assert.deepEqual(f.counts(), { calls: 0, observations: 0 });
    } finally {
      await f.dispose();
    }
  },
);
