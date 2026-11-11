import { test } from "node:test";
import assert from "node:assert/strict";
import { botFixture } from "./telegram-bot-fixture.ts";
import { linkedStudyFixture } from "./telegram-linked-fixture.ts";
import { actor, account } from "./telegram-fixture.ts";
import { actorKey } from "../packages/telegram/contracts.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";
import { barrier, queuedVoice } from "./telegram-repair1-fixture.ts";

async function connect(f: Awaited<ReturnType<typeof botFixture>>) {
  const flow = await f.begin();
  return f.complete(flow, await f.verify(flow));
}

for (const entry of ["new lesson", "resumed lesson", "active lesson"] as const)
  test(`repair5 fresh linked work after authority rotation on a ${entry}`, async (t) => {
    const f = await botFixture();
    t.after(f.dispose);
    const linked = await linkedStudyFixture(f);
    const original = await connect(f);
    if (entry !== "new lesson") await f.choose();
    f.authority("authority-2");
    if (entry === "new lesson") await f.choose();
    if (entry === "resumed lesson") await f.command("/resume");
    const job = await queuedVoice(f);
    assert.deepEqual(job.grant, {
      ...original,
      authorityVersion: "authority-2",
    });
    const result = await f.study.work(job.id);
    assert.equal(result.state, "applied");
    assert.equal(linked.calls(), 1);
    assert.equal(f.study.session(actor).view.progress.resolved, 1);
    assert.deepEqual(f.study.session(actor).grant, job.grant);
    assert.deepEqual(f.grants.read(actor), original);
    const row = f.database
      .prepare(
        "SELECT account_id,state,grade_json FROM study_attempts WHERE lesson_id=?",
      )
      .get(job.lessonId)!;
    assert.equal(row.account_id, account.accountId);
    assert.equal(row.state, "assessed");
    assert.doesNotMatch(String(row.grade_json), /heardTranscript/);
  });

test("repair5 old linked submission stays unresolved after authority rotation", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  const original = await connect(f);
  await f.choose();
  const job = await queuedVoice(f);
  linked.loseResponse();
  await assert.rejects(
    () => f.study.work(job.id),
    /simulated_linked_response_lost/,
  );
  const key = `speech-job:${job.id}`;
  const attempted = f.store.get<TelegramStudyWork>(key)!;
  assert.equal(attempted.state, "uncertain");
  assert.equal(attempted.submissionStarted, true);
  const readAttempts = () =>
    f.database
      .prepare(
        "SELECT attempt_id,state,audio_digest,grade_json FROM study_attempts WHERE lesson_id=?",
      )
      .all(job.lessonId);
  const attempts = readAttempts();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].audio_digest, attempted.audioDigest);
  f.authority("authority-2");
  await f.study.work(job.id);
  await f.study.work(job.id);
  const held = f.store.get<TelegramStudyWork>(key)!;
  assert.equal(held.state, "uncertain");
  assert.equal(held.voice, null);
  assert.deepEqual(held.grant, original);
  assert.equal(held.audioDigest, attempted.audioDigest);
  assert.equal(held.dispatchToken, attempted.dispatchToken);
  assert.equal(linked.calls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 0);
  assert.deepEqual(readAttempts(), attempts);
});

test("repair5 linked application checks trusted authority again after the D1 result", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  const job = await queuedVoice(f);
  const gate = barrier(),
    permit = f.study.permit.bind(f.study);
  f.study.permit = async (work) => {
    if (work.state === "assessed") await gate.pause();
    await permit(work);
  };
  const running = f.study.work(job.id);
  await gate.waiting;
  try {
    const row = f.database
      .prepare("SELECT state FROM study_attempts WHERE lesson_id=?")
      .get(job.lessonId);
    assert.equal(row?.state, "assessed");
    f.authority("authority-2");
  } finally {
    gate.release();
  }
  assert.equal((await running).state, "cancelled");
  await f.study.work(job.id);
  assert.equal(f.study.session(actor).view.progress.resolved, 0);
  assert.equal(linked.calls(), 1);
});

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
test("repair4 linked grades are redacted before D1 writes and legacy linked grades are scrubbed", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const privateSpeech = "fixture private learner speech";
  const linked = await linkedStudyFixture(f, privateSpeech);
  const grant = await connect(f);
  await f.choose();
  f.database
    .exec(`CREATE TRIGGER reject_raw_telegram_grade BEFORE UPDATE OF grade_json ON study_attempts
    WHEN NEW.grade_json LIKE '%heardTranscript%' OR NEW.grade_json LIKE '%fixture private%'
    BEGIN SELECT RAISE(ABORT, 'unredacted grade'); END`);
  linked.loseResponse();
  await f.answer();
  await f.bot.tick();
  const job = f.store.entries<TelegramStudyWork>("speech-job:")[0].value;
  const read = () =>
    f.database
      .prepare(
        "SELECT grade_json,audio_digest FROM study_attempts WHERE lesson_id=?",
      )
      .get(job.lessonId)!;
  assert.equal(job.state, "applied");
  assert.equal(linked.calls(), 1);
  const original = read();
  const grade = JSON.parse(String(original.grade_json));
  assert.equal(grade.correct, false);
  assert.doesNotMatch(
    String(original.grade_json),
    /heardTranscript|matched|substituted/,
  );
  assert.deepEqual(job.grade, grade);
  f.database.exec("DROP TRIGGER reject_raw_telegram_grade");
  f.database
    .prepare("UPDATE study_attempts SET grade_json=? WHERE lesson_id=?")
    .run(
      JSON.stringify({
        ...grade,
        heardTranscript: privateSpeech,
        extra: ["private"],
      }),
      job.lessonId,
    );
  await linked.adapter.get(actor, grant, job.lessonId);
  assert.deepEqual(read(), original);
  assert.equal(linked.calls(), 1);
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
