import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { actor, account } from "./telegram-fixture.ts";
import { botFixture, voiceBytes } from "./telegram-bot-fixture.ts";
import { barrier, queuedVoice, connect } from "./telegram-repair1-fixture.ts";
import { actorKey, TELEGRAM_OPEN_MS } from "../packages/telegram/contracts.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";
import { linkedStudyFixture } from "./telegram-linked-fixture.ts";

for (const change of [
  "bot-rotation",
  "bot-rotation-reclaim",
  "lesson-change",
  "lesson-closure",
])
  test(`unsent speech rechecks ${change} after admission returns`, async (t) => {
    const f = await botFixture();
    t.after(f.dispose);
    await f.choose();
    const job = await queuedVoice(f),
      paused = barrier(),
      dispatch = f.speech.admission.dispatch;
    if (change === "bot-rotation-reclaim") {
      const audioDigest = sha256(voiceBytes),
        requestId = `telegram:${job.id}:0`;
      await f.speech.admission.reserve({
        ...f.speech.config,
        channel: "telegram-trial",
        requestId,
        payloadDigest: audioDigest,
        units: 1,
      });
      await dispatch(requestId);
      f.store.set(`speech-job:${job.id}`, {
        ...job,
        state: "dispatching",
        audioDigest,
        submissionStarted: false,
      });
    }
    f.speech.admission.dispatch = async (id) => {
      const result = await dispatch(id);
      await paused.pause();
      return result;
    };
    const work = f.study.work(job.id);
    await paused.waiting;
    assert.equal(
      f.store.get<TelegramStudyWork>(`speech-job:${job.id}`)?.submissionStarted,
      false,
    );
    assert.equal(f.speechCalls(), 0);
    if (change.startsWith("bot-rotation"))
      f.grants.configure({ ...actor, generation: 2, enabled: true });
    else if (change === "lesson-change")
      f.store.set(
        `active-session:${actorKey(actor)}`,
        "different-current-lesson",
      );
    else {
      f.advance(TELEGRAM_OPEN_MS);
      f.trial.get(actor, job.lessonId);
    }
    paused.release();
    await work;
    assert.equal(f.speechCalls(), 0);
    assert.equal(
      f.store.get<TelegramStudyWork>(`speech-job:${job.id}`)?.submissionStarted,
      false,
    );
    await f.study.work(job.id);
    assert.equal(f.speechCalls(), 0);
  });

for (const change of ["bot-rotation", "unlink"])
  test(`linked proven-unsent boundary rechecks ${change} after async authority returns`, async (t) => {
    const f = await botFixture();
    t.after(f.dispose);
    const linked = await linkedStudyFixture(f);
    await connect(f);
    await f.choose();
    const job = await queuedVoice(f),
      paused = barrier(),
      permit = f.study.permit.bind(f.study);
    let once = true;
    f.study.permit = async (job) => {
      await permit(job);
      if (once && job.state === "dispatching") {
        once = false;
        await paused.pause();
      }
    };
    const work = f.study.work(job.id);
    await paused.waiting;
    assert.equal(
      f.store.get<TelegramStudyWork>(`speech-job:${job.id}`)?.submissionStarted,
      false,
    );
    if (change === "unlink") f.grants.unlink(actor, account.accountId);
    else f.grants.configure({ ...actor, generation: 2, enabled: true });
    paused.release();
    await work;
    assert.equal(linked.calls(), 0);
    assert.equal(
      f.store.get<TelegramStudyWork>(`speech-job:${job.id}`)?.submissionStarted,
      false,
    );
  });
