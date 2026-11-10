import test from "node:test";
import assert from "node:assert/strict";
import { studyPublicationFixture } from "./study-publication-fixture.ts";
import { deleteExpiredStudyHistory } from "../services/study-retention.ts";
import { STUDY_HISTORY_EXPORT_WINDOW_MS } from "../services/study-history.ts";

interface Draft {
  lesson_id: string;
  account_id: string;
  request_id: string;
  song_json: string;
  state_json: string;
  started_at: number;
  history_deleted_at: number | null;
}

test(
  "an expired draft without a grant or local outbox erases its private association but keeps replay identity",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19894);
    try {
      const auth = await f.login(6),
        requestId = crypto.randomUUID();
      const response = await f.post(
        "/api/study/lessons",
        { song: f.song, requestId },
        auth,
      );
      assert.equal(response.status, 503);
      const draft = await f.db
        .prepare("SELECT * FROM study_lessons WHERE request_id=?")
        .bind(requestId)
        .first<Draft>();
      assert.ok(draft);
      assert.notEqual(draft.song_json, "{}");
      assert.equal(
        (await f.db
          .prepare(
            "SELECT count(*) AS n FROM study_publications WHERE lesson_id=?",
          )
          .bind(draft.lesson_id)
          .first<{ n: number }>())!.n,
        0,
      );
      const counts = f.counts(),
        txs = f.store.entries("tx:"),
        ledger = f.store.get("sponsor:ledger"),
        bindings = f.store.entries("studyBinding:");
      f.advance(
        JSON.parse(draft.state_json).expiresAt +
          STUDY_HISTORY_EXPORT_WINDOW_MS +
          1 -
          f.clock(),
      );
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        1,
      );
      const erased = (await f.db
        .prepare("SELECT * FROM study_lessons WHERE lesson_id=?")
        .bind(draft.lesson_id)
        .first<Draft>())!;
      assert.equal(erased.song_json, "{}");
      assert.equal(erased.started_at, 0);
      assert.equal(erased.state_json, "{}");
      assert.equal(erased.history_deleted_at, f.clock());
      assert.equal(erased.account_id, draft.account_id);
      assert.equal(erased.request_id, requestId);
      const fresh = await f.login(6);
      assert.equal(
        (await f.post("/api/study/lessons", { song: f.song, requestId }, fresh))
          .status,
        410,
      );
      assert.deepEqual(f.counts(), counts);
      assert.deepEqual(f.store.entries("tx:"), txs);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.deepEqual(f.store.entries("studyBinding:"), bindings);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a held bind response cannot recreate D1 associations after purge or repeat the remote binding",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19895),
      started = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>();
    let pending: Promise<unknown> | undefined;
    try {
      const original = f.env.KARAOKE_OPERATOR!;
      let bindCalls = 0;
      f.env.KARAOKE_OPERATOR = {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(input, init),
            response = await original.fetch(request);
          if (new URL(request.url).pathname === "/study/bind") {
            bindCalls++;
            started.resolve();
            await held.promise;
          }
          return response;
        },
      } as Fetcher;
      const opening = f.start().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      pending = opening;
      await started.promise; // The remote binding exists; its response is still held.
      const draft = (await f.db
        .prepare("SELECT * FROM study_lessons LIMIT 1")
        .first<Draft>())!;
      const bindings = f.store.entries("studyBinding:"),
        ledger = f.store.get("sponsor:ledger"),
        txs = f.store.entries("tx:"),
        counts = f.counts();
      assert.equal(bindings.length, 1);
      assert.equal(
        (await f.db
          .prepare("SELECT count(*) AS n FROM study_publications")
          .first<{ n: number }>())!.n,
        0,
      );
      f.advance(
        JSON.parse(draft.state_json).expiresAt +
          STUDY_HISTORY_EXPORT_WINDOW_MS +
          1 -
          f.clock(),
      );
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        1,
      );
      const erasedBeforeRelease = (await f.db
        .prepare("SELECT * FROM study_lessons WHERE lesson_id=?")
        .bind(draft.lesson_id)
        .first<Draft>())!;
      assert.equal(erasedBeforeRelease.song_json, "{}");
      assert.equal(erasedBeforeRelease.started_at, 0);
      assert.equal(erasedBeforeRelease.history_deleted_at, f.clock());
      held.resolve();
      assert.ok("error" in (await opening));
      assert.equal(
        (await f.db
          .prepare("SELECT count(*) AS n FROM study_publications")
          .first<{ n: number }>())!.n,
        0,
      );
      const after = (await f.db
        .prepare("SELECT * FROM study_lessons WHERE lesson_id=?")
        .bind(draft.lesson_id)
        .first<Draft>())!;
      assert.deepEqual(after, erasedBeforeRelease);
      const fresh = await f.login();
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            { song: f.song, requestId: draft.request_id },
            fresh,
          )
        ).status,
        410,
      );
      assert.equal(bindCalls, 1);
      // This uncertain remote authority is preserved, not inferred absent locally.
      assert.deepEqual(f.store.entries("studyBinding:"), bindings);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.deepEqual(f.store.entries("tx:"), txs);
      assert.deepEqual(f.counts(), counts);
    } finally {
      held.resolve();
      await pending;
      await f.dispose();
    }
  },
);
