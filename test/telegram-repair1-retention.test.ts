import { test } from "node:test";
import assert from "node:assert/strict";
import { actor } from "./telegram-fixture.ts";
import { botFixture } from "./telegram-bot-fixture.ts";
import { linkedStudyFixture } from "./telegram-linked-fixture.ts";
import { connect, queuedVoice, barrier } from "./telegram-repair1-fixture.ts";
import {
  actorKey,
  TELEGRAM_HISTORY_MS,
  TELEGRAM_OPEN_MS,
} from "../packages/telegram/contracts.ts";
import type {
  TelegramStudySession,
  TelegramStudyWork,
} from "../packages/telegram/work.ts";
import { telegramTrialRetention } from "../services/telegram-retention.ts";
import { telegramCopyRetention } from "../services/telegram-copy-retention.ts";
import type { TelegramOutbound } from "../services/telegram-outbox.ts";

test("linked queued voice expires at 24h, releases the pending answer and never repeats speech", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  const job = await queuedVoice(f);
  f.advance(25 * 3600_000);
  const result = telegramTrialRetention(f.trial, actor.communityId);
  assert.equal(result.handlesErased, 1);
  assert.equal(
    f.store.get<TelegramStudyWork>(`speech-job:${job.id}`)?.voice,
    null,
  );
  assert.equal(
    f.store.get<TelegramStudyWork>(`speech-job:${job.id}`)?.state,
    "cancelled",
  );
  await f.answer();
  await f.bot.tick();
  assert.equal(linked.calls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
});

test("linked history and unknown replay evidence are cleaned deterministically beyond 1000 rows using bounded pages", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  const job = await queuedVoice(f),
    template = f.study.session(actor),
    key = actorKey(actor);
  f.store.delete(`speech-job:${job.id}`);
  f.store.delete(`job-ready:${job.id}`);
  f.store.delete(`session:${key}:${template.view.id}`);
  for (let i = 0; i < 1005; i++) {
    const id = `linked-copy-${String(i).padStart(5, "0")}`,
      jobId = `linked-job-${String(i).padStart(5, "0")}`;
    const view = {
      ...template.view,
      id,
      status: "completed" as const,
      completedAt: f.now(),
      prompt: null,
    };
    f.store.set(`session:${key}:${id}`, { ...template, view });
    f.store.set(`speech-job:${jobId}`, {
      ...job,
      id: jobId,
      lessonId: id,
      resultView: view,
      state: i === 1004 ? "uncertain" : "applied",
      submissionStarted: true,
      grade: { heardTranscript: "PRIVATE_LINKED_SENTINEL" },
    });
    f.store.set(`lesson-job:${key}:${id}:${jobId}`, jobId);
    f.store.set(`job-ready:${jobId}`, jobId);
  }
  f.advance(TELEGRAM_HISTORY_MS + 1);
  const entries = f.store.entries;
  let biggest = 0;
  f.store.entries = <T>(prefix: string, limit?: number, after?: string) => {
    biggest = Math.max(biggest, limit ?? 1000);
    return entries.call(f.store, prefix, limit, after) as {
      key: string;
      value: T;
    }[];
  };
  for (let i = 0; i < 110; i++)
    telegramCopyRetention(f.grants, actor.communityId, 10);
  f.store.entries = entries;
  assert.equal(biggest, 10);
  assert.equal(f.store.entries("session:", 10000).length, 0);
  assert.equal(f.store.entries("speech-job:", 10000).length, 0);
  assert.equal(f.store.entries("job-ready:", 10000).length, 0);
  const evidence = f.store.get<any>("job-tombstone:linked-job-01004");
  assert.equal(evidence.unknown, true);
  assert.equal(evidence.voiceFingerprint, job.voiceFingerprint);
  assert.equal(
    JSON.stringify(evidence).includes("PRIVATE_LINKED_SENTINEL"),
    false,
  );
  const before = JSON.stringify(f.store.entries("job-tombstone:", 10000));
  for (let i = 0; i < 3; i++)
    telegramCopyRetention(f.grants, actor.communityId, 10);
  assert.equal(
    JSON.stringify(f.store.entries("job-tombstone:", 10000)),
    before,
  );
  assert.equal(linked.calls(), 0);
});

test("linked unknown work loses voice at 24h and becomes minimal evidence at bounded history expiry", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  const job = await queuedVoice(f);
  f.store.set(`speech-job:${job.id}`, {
    ...job,
    state: "uncertain",
    submissionStarted: true,
  });
  f.advance(25 * 3600_000);
  telegramTrialRetention(f.trial, actor.communityId);
  assert.equal(
    f.store.get<TelegramStudyWork>(`speech-job:${job.id}`)?.voice,
    null,
  );
  assert.equal(
    f.store.get<TelegramStudyWork>(`speech-job:${job.id}`)?.state,
    "uncertain",
  );
  f.advance(TELEGRAM_OPEN_MS + TELEGRAM_HISTORY_MS);
  telegramTrialRetention(f.trial, actor.communityId);
  assert.equal(f.store.get(`speech-job:${job.id}`), undefined);
  assert.equal(f.store.get<any>(`job-tombstone:${job.id}`).unknown, true);
  assert.equal(linked.calls(), 0);
});

test("a paused linked resume cannot restore an expired private session", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  const id = f.study.session(actor).view.id,
    paused = barrier(),
    get = f.linked.get;
  f.linked.get = async (...args) => {
    await paused.pause();
    return get(...args);
  };
  const resume = f.study.resume(actor);
  await paused.waiting;
  f.advance(TELEGRAM_OPEN_MS + TELEGRAM_HISTORY_MS + 1);
  telegramTrialRetention(f.trial, actor.communityId);
  paused.release();
  await assert.rejects(resume, /history_expired/);
  assert.equal(f.store.get(`session:${actorKey(actor)}:${id}`), undefined);
});

test("expired legacy exports are scrubbed through every page without session or trial indices", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.command("/start");
  for (let i = 0; i < 1005; i++)
    f.outbox.enqueue(actor, `legacy-export-${i}`, {
      kind: "document",
      filename: "private.json",
      content: "PRIVATE_PAGED_EXPORT",
      expiresAt: f.now() + 1,
    });
  f.advance(2);
  for (let i = 0; i < 105; i++)
    telegramCopyRetention(f.grants, actor.communityId, 10);
  const rows = f.store.entries<TelegramOutbound>("outbox:", 10000);
  assert.equal(
    rows.filter((row) => row.value.payload.kind === "document").length,
    0,
  );
  assert.equal(
    rows.some((row) =>
      JSON.stringify(row.value).includes("PRIVATE_PAGED_EXPORT"),
    ),
    false,
  );
  assert.equal(f.speechCalls(), 0);
});

test("a linked submit receipt returning after cleanup cannot restore job or session history", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  const job = await queuedVoice(f),
    paused = barrier(),
    answer = f.linked.answer;
  f.linked.answer = async (...args) => {
    const result = await answer(...args);
    await paused.pause();
    return result;
  };
  const work = f.study.work(job.id);
  await paused.waiting;
  f.advance(TELEGRAM_OPEN_MS + TELEGRAM_HISTORY_MS + 1);
  telegramTrialRetention(f.trial, actor.communityId);
  paused.release();
  await work;
  assert.equal(f.store.get(`speech-job:${job.id}`), undefined);
  assert.equal(
    f.store.get(`session:${actorKey(actor)}:${job.lessonId}`),
    undefined,
  );
  assert.equal(f.store.get<any>(`job-tombstone:${job.id}`).unknown, true);
  assert.equal(linked.calls(), 1);
});
