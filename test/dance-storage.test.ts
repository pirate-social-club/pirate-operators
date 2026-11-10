// DEFERRED heavy slot: real D1 schema/transaction regressions, not run repair1.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { danceFixture } from "./dance-fixture.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { decisionIntent } from "../packages/dance/intent.ts";
test("actual D1 preserves immutable pending intent/outbox, CAS and withdrawal fences", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB"),
      store = new DanceStore(db),
      model = danceFixture();
    model.store.time = Date.now();
    const sql = await readFile(
      new URL("../packages/dance/schema.sql", import.meta.url),
      "utf8",
    );
    await db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .trim()
        .split(/;\s*(?=CREATE|$)/)
        .filter((s) => s.trim())
        .map((s) => db.prepare(s)),
    );
    const prepared = await model.prepare(),
      r = await model.store.review(prepared.reviewId);
    await db.batch([
      db
        .prepare("INSERT INTO dance_captures VALUES(?,?,?,?,?,?)")
        .bind(
          r.reviewId,
          r.capture.communityId,
          r.capture.learner.accountId,
          "seed_capture",
          "seed_hash",
          JSON.stringify({ ...r.capture, consent: null }),
        ),
      db
        .prepare("INSERT INTO dance_consents VALUES(?,?)")
        .bind(r.reviewId, JSON.stringify(r.capture.consent)),
      db
        .prepare(
          "INSERT INTO dance_reviews(review_id,community_id,account_id,media_id,recording_digest,media_json,receipt_json,state) VALUES(?,?,?,?,?,?,?,'awaiting_review')",
        )
        .bind(
          r.reviewId,
          r.capture.communityId,
          r.capture.learner.accountId,
          r.receipt.mediaId,
          r.media.recordingSha256,
          JSON.stringify(r.media),
          JSON.stringify(r.receipt),
        ),
    ]);
    const reviewer = await model.service.permissions.reviewer(
      await model.service.permissions.facts("owner", "learner"),
    );
    const intent = decisionIntent(
      r,
      "d1_original",
      "pass",
      reviewer,
      Date.now(),
    );
    const input = {
      review: r,
      actor: "owner",
      requestHash: "request_hash",
      intent,
      fences: [{ sql: "1", values: [] }],
    };
    const accepted = await store.stageDecision(input);
    assert.equal(accepted.state, "decision_pending");
    const current = await store.review(r.reviewId);
    assert.equal(current.canonical, null);
    assert.equal(
      current.decision?.localIntegrityHash,
      intent.localIntegrityHash,
    );
    const opposite = decisionIntent(
      r,
      "d1_opposite",
      "not_passed",
      reviewer,
      Date.now(),
    );
    await assert.rejects(
      store.stageDecision({ ...input, intent: opposite }),
      /dance_fence_changed/,
    );
    await assert.rejects(
      db.prepare("DELETE FROM dance_decision_intents").run(),
      /dance_intent_immutable/,
    );
    assert.equal(
      (await store.outbox("d1_original")).payloadJson,
      JSON.stringify(
        JSON.parse((await store.outbox("d1_original")).payloadJson),
      ),
    );
    await store.stageWithdrawal({
      review: current,
      actor: "learner",
      commandId: "withdraw",
      requestHash: "withdraw_hash",
      fences: [{ sql: "1", values: [] }],
    });
    await assert.rejects(
      store.assertAccess(current, [{ sql: "1", values: [] }]),
      /dance_fence_changed/,
    );
    assert.equal(
      (await store.review(r.reviewId)).decision?.commandId,
      "d1_original",
    );
  } finally {
    await runtime.dispose();
  }
});
