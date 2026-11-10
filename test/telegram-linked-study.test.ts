import { test } from "node:test";
import assert from "node:assert/strict";
import { botFixture } from "./telegram-bot-fixture.ts";
import { linkedStudyFixture } from "./telegram-linked-fixture.ts";
import { actor, account } from "./telegram-fixture.ts";
import { actorKey } from "../packages/telegram/contracts.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";

async function connect(f: Awaited<ReturnType<typeof botFixture>>) {
  const flow = await f.begin();
  return f.complete(flow, await f.verify(flow));
}

test("future connected lessons use the existing Study account/queue; the earlier trial remains private and unrewarded", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  await f.answer();
  const trialId = f.study.session(actor).view.id;
  const linked = await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  const lesson = f.study.session(actor).view;
  assert.equal(lesson.mode, "linked");
  assert.notEqual(lesson.id, trialId);
  for (let i = 0; i < 4; i++) await f.answer();
  assert.equal(f.study.session(actor).view.status, "completed");
  assert.equal(linked.calls(), 4);
  assert.equal(f.trial.get(actor, trialId).progress.resolved, 1);
  const row = await linked.db
    .prepare("SELECT account_id FROM study_lessons WHERE lesson_id=?")
    .bind(lesson.id)
    .first<{ account_id: string }>();
  assert.equal(row?.account_id, account.accountId);
  assert.equal(f.store.entries(`trial:${actorKey(actor)}:`).length, 1);
  assert.equal(
    linked.entries(),
    0,
    "UI score must not write the shared economic ledger",
  );
  assert.equal(
    f.sent.some(
      (item) =>
        item.message.kind === "text" &&
        /Entered in today's lottery/.test(item.message.text),
    ),
    false,
  );
});
test("lost linked submit response recovers exact existing attempt/audio, not another provider request", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  linked.loseResponse();
  await f.answer();
  assert.equal(linked.calls(), 1);
  await f.bot.tick();
  assert.equal(linked.calls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
  const job = f.store.entries<TelegramStudyWork>("speech-job:")[0].value;
  await assert.rejects(
    linked.adapter.recover(
      actor,
      job.grant!,
      job.lessonId,
      job.expected,
      "0x" + "0".repeat(64),
    ),
    /audio_changed/,
  );
});
test("unlink before queued connected speech prevents grading and publication", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  const update = f.voiceUpdate();
  await f.webhook(update);
  for (const row of f.store.entries<string>("update-ready:"))
    await f.bot.processUpdate(row.value);
  f.grants.unlink(actor, account.accountId);
  await f.bot.tick();
  assert.equal(linked.calls(), 0);
  assert.equal(linked.entries(), 0);
  assert.equal(
    f.store.entries<TelegramStudyWork>("speech-job:")[0].value.state,
    "cancelled",
  );
});
test("website-reserved channel cannot be silently used by connected Telegram", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  linked.bindChannel("website-study");
  const grant = await f.grants.assert(actor),
    song = await f.catalog.song(actor, "song-one", grant);
  await assert.rejects(
    linked.adapter.start(actor, grant, song, "telegram_channel_fixture_123"),
    /channel_not_bound/,
  );
  assert.equal(linked.calls(), 0);
});
test("returning linked learner resumes in chat without using a browser session", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  const grant = await connect(f);
  await f.choose();
  await f.answer();
  const id = f.study.session(actor).view.id;
  f.advance(86400_000);
  await f.command("/resume");
  assert.equal(f.study.session(actor).view.id, id);
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
  assert.equal((await f.grants.assert(actor)).id, grant.id);
  assert.ok(linked.authorityCalls() > 0);
});

test("a legacy Study factory without the durable Telegram publication fence is held before speech", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  linked.fenceVersion(0);
  const grant = await f.grants.assert(actor),
    song = await f.catalog.song(actor, "song-one", grant);
  await assert.rejects(
    linked.adapter.start(actor, grant, song, "telegram_fence_fixture_123"),
    /publication_fence_required/,
  );
  assert.equal(linked.calls(), 0);
  assert.equal(linked.entries(), 0);
});
