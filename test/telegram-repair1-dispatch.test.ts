import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { actor } from "./telegram-fixture.ts";
import { botFixture, voiceBytes } from "./telegram-bot-fixture.ts";
import { linkedStudyFixture } from "./telegram-linked-fixture.ts";
import {
  barrier,
  queuedVoice,
  restartedSpeech,
  connect,
} from "./telegram-repair1-fixture.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";

test("a legacy dispatching snapshot with an admission reservation still reserved progresses exactly once after restart", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const job = await queuedVoice(f),
    digest = sha256(voiceBytes);
  await f.speech.admission.reserve({
    ...f.speech.config,
    channel: "telegram-trial",
    requestId: `telegram:${job.id}:0`,
    payloadDigest: digest,
    units: 1,
  });
  f.store.set(`speech-job:${job.id}`, {
    ...job,
    state: "dispatching",
    audioDigest: digest,
  });
  f.study.options.speech = restartedSpeech(f);
  await f.bot.tick();
  await f.bot.tick();
  assert.equal(f.speechCalls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
});

for (const atAdmission of [false, true])
  test(`reclaiming proven-unsent trial work fences a paused owner ${atAdmission ? "inside admission dispatch" : "before admission dispatch"}`, async (t) => {
    const f = await botFixture();
    t.after(f.dispose);
    await f.choose();
    const job = await queuedVoice(f),
      paused = barrier();
    f.study.options.speech = restartedSpeech(
      f,
      atAdmission ? undefined : paused,
    );
    if (atAdmission) {
      const dispatch = f.speech.admission.dispatch;
      let once = true;
      f.speech.admission.dispatch = async (id) => {
        const result = await dispatch(id);
        if (once) {
          once = false;
          await paused.pause();
        }
        return result;
      };
    }
    const a = f.study.work(job.id);
    await paused.waiting;
    f.study.options.speech = restartedSpeech(f);
    await f.study.work(job.id);
    paused.release();
    await a;
    await f.bot.tick();
    assert.equal(f.speechCalls(), 1);
    assert.equal(f.study.session(actor).view.progress.resolved, 1);
  });

test("unknown trial submission without a receipt never becomes an unsent retry", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const job = await queuedVoice(f);
  f.store.set(`speech-job:${job.id}`, {
    ...job,
    state: "dispatching",
    submissionStarted: true,
    audioDigest: sha256(voiceBytes),
  });
  f.study.options.speech = restartedSpeech(f);
  await f.bot.tick();
  await f.bot.tick();
  assert.equal(f.speechCalls(), 0);
  assert.equal(
    f.store.get<TelegramStudyWork>(`speech-job:${job.id}`)?.state,
    "uncertain",
  );
});

test("linked proven-unsent crash progresses once; an unknown submission with no attempt stays held", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  const job = await queuedVoice(f);
  f.store.set(`speech-job:${job.id}`, {
    ...job,
    state: "dispatching",
    submissionStarted: false,
    audioDigest: sha256(voiceBytes),
  });
  await f.bot.tick();
  await f.bot.tick();
  assert.equal(linked.calls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
  const unknown = await queuedVoice(f);
  f.store.set(`speech-job:${unknown.id}`, {
    ...unknown,
    state: "dispatching",
    submissionStarted: true,
    audioDigest: sha256(voiceBytes),
  });
  await f.bot.tick();
  await f.bot.tick();
  assert.equal(linked.calls(), 1);
  assert.equal(
    f.store.get<TelegramStudyWork>(`speech-job:${unknown.id}`)?.state,
    "uncertain",
  );
});

test("linked restart fences a worker paused before the service boundary", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const linked = await linkedStudyFixture(f);
  await connect(f);
  await f.choose();
  const job = await queuedVoice(f),
    paused = barrier(),
    original = f.study.permit.bind(f.study);
  let once = true;
  f.study.permit = async (job) => {
    if (once && job.state === "dispatching") {
      once = false;
      await paused.pause();
    }
    return original(job);
  };
  const a = f.study.work(job.id);
  await paused.waiting;
  await f.study.work(job.id);
  paused.release();
  await a;
  await f.bot.tick();
  assert.equal(linked.calls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
});
