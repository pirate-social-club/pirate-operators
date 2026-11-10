import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "viem";
import { actor, journalFixture } from "./telegram-fixture.ts";
import { botFixture, voiceBytes } from "./telegram-bot-fixture.ts";
import { barrier, queuedVoice } from "./telegram-repair1-fixture.ts";
import {
  TelegramTrialSpeech,
  type TelegramSpeechAdmission,
} from "../services/telegram-speech.ts";
import { TelegramSqlJournal } from "../services/telegram-store.ts";
import { telegramTrialRetention } from "../services/telegram-retention.ts";
import {
  TELEGRAM_OPEN_MS,
  TELEGRAM_HISTORY_MS,
  actorKey,
} from "../packages/telegram/contracts.ts";
import { digest } from "../packages/protocol/index.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";
import type { TelegramTrialRecord } from "../packages/telegram/study-contracts.ts";
import type { TelegramOutbound } from "../services/telegram-outbox.ts";
import { trialDebitKey } from "../services/telegram-trial-quota.ts";

const pinned = new URL(
  "../.local/telegram-repair3-lane5/services/study-speech-admission.ts",
  import.meta.url,
);
const integrated = new URL(
  "../services/study-speech-admission.ts",
  import.meta.url,
);
const source = existsSync(pinned) ? pinned : integrated;
const sourceAvailable = existsSync(source);
if (source.href === pinned.href)
  assert.equal(
    createHash("sha256").update(readFileSync(pinned)).digest("hex"),
    "bb9d1eeb8cf10334feee31951eeb6431cd308b230e45810620fd06c01561a8c9",
  );

type ActualAdmission = Omit<TelegramSpeechAdmission, "get"> & {
  get(id: string): { state: string; evidenceDigest: string | null } | null;
};
const withLane5 = {
  skip: sourceAvailable
    ? false
    : "lane 5 admission source is supplied at integration or through the pinned local fixture",
};

function persisted<T>(f: Awaited<ReturnType<typeof fixture>>, key: string): T {
  const row = f.database
    .prepare("SELECT value FROM telegram_journal WHERE key=?")
    .get(key);
  return JSON.parse(String(row?.value)) as T;
}

async function fixture(t: import("node:test").TestContext, dailySpeech = 20) {
  const f = await botFixture({ dailySpeech }),
    ledger = journalFixture();
  t.after(f.dispose);
  t.after(ledger.close);
  const { CommunitySpeechAdmission } = await import(fileURLToPath(source));
  const policy = {
    ...f.speech.config,
    dailyUnits: 5,
    websiteStudyReservedUnits: 1,
    telegramTrialUnits: 1,
  };
  const constructor = CommunitySpeechAdmission as new (
    storage: typeof ledger.storage,
    options: typeof policy,
    now: () => number,
  ) => ActualAdmission;
  let actual = new constructor(ledger.storage, policy, f.now);
  const effects: { id: string; state: string; evidence: string }[] = [];
  const ports: TelegramSpeechAdmission = {
    reserve: (input) => actual.reserve(input),
    dispatch: (id) => actual.dispatch(id),
    get: (id) => actual.get(id),
    resolve(id, state, evidence) {
      effects.push({ id, state, evidence });
      return actual.resolve(id, state, evidence);
    },
  };
  const transcriber = f.speech.transcriber;
  let statusReads = 0;
  const recover = transcriber.recover!;
  transcriber.recover = async (...args) => {
    statusReads++;
    return recover(...args);
  };
  function restart() {
    actual = new constructor(ledger.storage, policy, f.now);
    f.study.options.speech = new TelegramTrialSpeech({
      store: new TelegramSqlJournal(f.storage),
      config: f.speech.config,
      admission: ports,
      transcriber,
      files: f.files,
      permit: (job) => f.study.permit(job as TelegramStudyWork),
      beforeSubmission: (job) =>
        f.study.beforeSubmission(job as TelegramStudyWork),
      now: f.now,
    });
  }
  restart();
  await f.choose();
  const job = await queuedVoice(f),
    id = `telegram:${job.id}:0`,
    payloadDigest = sha256(voiceBytes);
  const reserve = (requestId = id) =>
    actual.reserve({
      ...f.speech.config,
      channel: "telegram-trial",
      requestId,
      payloadDigest,
      units: 1,
    });
  const current = () => f.store.get<TelegramStudyWork>(`speech-job:${job.id}`);
  const rotate = () =>
    f.grants.configure({ ...actor, generation: 2, enabled: true });
  return {
    ...f,
    job,
    id,
    ports,
    effects,
    restart,
    reserve,
    current,
    rotate,
    payloadDigest,
    statusReads: () => statusReads,
    actual: () => actual,
  };
}

test(
  "lane 5 success commit with lost reply settles the identical digest after restart",
  withLane5,
  async (t) => {
    const f = await fixture(t),
      resolve = f.ports.resolve;
    let lost = false;
    f.ports.resolve = async (id, state, evidence) => {
      const result = await resolve(id, state, evidence);
      if (state === "succeeded" && !lost) {
        lost = true;
        throw new Error("fixture_lost_success_reply");
      }
      return result;
    };
    await f.bot.tick();
    const expected = digest(f.providerReceipts.get(f.job.id));
    assert.equal(f.actual().get(f.id)?.evidenceDigest, expected);
    assert.equal(f.study.session(actor).view.progress.resolved, 0);
    f.restart();
    await f.bot.tick();
    await f.bot.tick();
    assert.equal(f.study.session(actor).view.progress.resolved, 1);
    assert.equal(f.speechCalls(), 1);
    assert.ok(f.effects.length >= 2);
    assert.ok(
      f.effects.every(
        (effect) =>
          effect.id === f.id &&
          effect.state === "succeeded" &&
          effect.evidence === expected,
      ),
    );
  },
);

test(
  "repair4 settling and applied trial grades persist no learner transcript",
  withLane5,
  async (t) => {
    const f = await fixture(t);
    const transcript = {
      text: "fixture private learner speech",
      language: "en",
    };
    const transcribe = f.speech.transcriber.transcribe;
    f.speech.transcriber.transcribe = async (...args) => {
      await transcribe(...args);
      f.providerReceipts.set(f.job.id, transcript);
      return transcript;
    };
    const resolve = f.ports.resolve;
    let lost = false;
    f.ports.resolve = async (...args) => {
      const result = await resolve(...args);
      if (!lost) {
        lost = true;
        throw new Error("fixture_lost_success_reply");
      }
      return result;
    };
    await f.bot.tick();
    const key = `speech-job:${f.job.id}`;
    const settling = persisted<TelegramStudyWork>(f, key);
    assert.equal(settling.state, "settling");
    assert.equal(f.actual().get(f.id)?.evidenceDigest, digest(transcript));
    assert.deepEqual(settling.grade, {
      correct: false,
      matchKind: "none",
      policyRevision: f.job.policy,
    });
    const legacyGrade = {
      ...settling.grade,
      heardTranscript: transcript.text,
      substituted: [{ heard: transcript.text }],
    };
    const inject = (key: string, value: unknown) =>
      f.database
        .prepare("UPDATE telegram_journal SET value=? WHERE key=?")
        .run(JSON.stringify(value), key);
    inject(key, { ...settling, grade: legacyGrade });
    f.restart();
    await f.bot.tick();
    const applied = persisted<TelegramStudyWork>(f, key);
    assert.equal(applied.state, "applied");
    assert.deepEqual(applied.grade, settling.grade);
    assert.deepEqual(applied.resolution, settling.resolution);
    assert.ok(
      f.effects.every((effect) => effect.evidence === digest(transcript)),
    );
    const outbox = f.store.entries<TelegramOutbound>("outbox:");
    assert.doesNotMatch(JSON.stringify(outbox), /fixture private|You said:/);
    const verdict = outbox.find(
      (row) => row.value.effectId === `outcome:${f.job.id}:0`,
    )!;
    assert.equal(verdict.value.payload.kind, "text");
    inject(key, { ...applied, grade: legacyGrade });
    inject(verdict.key, {
      ...verdict.value,
      payload: {
        kind: "text",
        text: `Incorrect\nYou said: “${transcript.text}”`,
      },
    });
    telegramTrialRetention(f.trial, actor.communityId);
    assert.deepEqual(persisted<TelegramStudyWork>(f, key), applied);
    assert.deepEqual(
      persisted<TelegramOutbound>(f, verdict.key),
      verdict.value,
    );
    assert.equal(f.speechCalls(), 1);
  },
);

test(
  "repair4 unsent rotated cancellation refunds its original persisted guest debit once",
  withLane5,
  async (t) => {
    const f = await fixture(t, 1);
    const original = `trial-quota:${actorKey(actor)}:${f.job.reservedDay}`;
    const otherDay = `trial-quota:${actorKey(actor)}:${f.job.reservedDay + 1}`;
    f.store.set(otherDay, 4);
    f.reserve();
    await f.actual().dispatch(f.id);
    f.store.set(`speech-job:${f.job.id}`, {
      ...f.job,
      state: "dispatching",
      submissionStarted: false,
      audioDigest: f.payloadDigest,
      reservation: { ...f.job.reservation!, started: true },
    });
    const resolve = f.ports.resolve;
    let lost = false;
    f.ports.resolve = async (...args) => {
      const result = await resolve(...args);
      if (!lost) {
        lost = true;
        throw new Error("fixture_lost_release_reply");
      }
      return result;
    };
    f.advance(86400_000);
    f.rotate();
    await f.study.work(f.job.id);
    assert.equal(f.current()?.state, "releasing");
    assert.equal(persisted<number>(f, original), 0);
    f.restart();
    await f.study.work(f.job.id);
    await f.study.work(f.job.id);
    assert.equal(f.current()?.state, "cancelled");
    assert.equal(f.actual().get(f.id)?.state, "refused");
    assert.equal(persisted<number>(f, original), 0);
    assert.equal(persisted<number>(f, otherDay), 4);
    assert.equal(f.speechCalls(), 0);
  },
);

test(
  "repair4 guest debit and unsent cancellation roll back together before provider compensation",
  withLane5,
  async (t) => {
    const f = await fixture(t, 1);
    const original = `trial-quota:${actorKey(actor)}:${f.job.reservedDay}`;
    f.reserve();
    await f.actual().dispatch(f.id);
    f.store.set(`speech-job:${f.job.id}`, {
      ...f.job,
      state: "dispatching",
      submissionStarted: false,
      audioDigest: f.payloadDigest,
      reservation: { ...f.job.reservation!, started: true },
    });
    f.rotate();
    f.database
      .exec(`CREATE TRIGGER fail_guest_cancellation BEFORE UPDATE ON telegram_journal
    WHEN NEW.key LIKE 'speech-job:%' AND json_extract(NEW.value,'$.state')='releasing'
    BEGIN SELECT RAISE(ABORT, 'fixture_atomic_cancel'); END`);
    await assert.rejects(() => f.study.work(f.job.id), /fixture_atomic_cancel/);
    assert.equal(f.current()?.state, "dispatching");
    assert.equal(persisted<number>(f, original), 1);
    assert.equal(f.actual().get(f.id)?.state, "dispatched");
    assert.equal(f.effects.length, 0);
    assert.ok(f.store.get(trialDebitKey(f.job.id)));
    f.database.exec("DROP TRIGGER fail_guest_cancellation");
    f.restart();
    await f.study.work(f.job.id);
    await f.study.work(f.job.id);
    assert.equal(f.current()?.state, "cancelled");
    assert.equal(persisted<number>(f, original), 0);
    assert.equal(f.store.get(trialDebitKey(f.job.id)), undefined);
    assert.equal(f.actual().get(f.id)?.state, "refused");
    assert.equal(f.speechCalls(), 0);
    const currentActor = { ...actor, generation: 2 };
    f.grants.start(currentActor);
    await f.study.resume(currentActor);
    const prompt = f.sent.find(
      (item) =>
        (item.message.kind === "text" || item.message.kind === "voice") &&
        item.message.promptKey === f.job.promptKey,
    )!;
    const replacement = await f.study.accept(
      currentActor,
      f.job.voice!,
      prompt.messageId,
      98765,
    );
    assert.notEqual(replacement.id, f.job.id);
    await f.study.work(f.job.id);
    assert.equal(persisted<number>(f, original), 1);
  },
);

test(
  "repair4 retention cannot apply an old-generation assessment after delayed authorization",
  withLane5,
  async (t) => {
    const f = await fixture(t);
    f.fail("unknown");
    f.recoverReady(false);
    await f.study.options.speech.work(f.job.id);
    assert.equal(f.current()?.state, "uncertain");
    f.recoverReady(true);
    const gate = barrier();
    const permit = f.study.permit.bind(f.study);
    f.study.permit = async (job) => {
      await permit(job);
      if (job.state === "assessed") await gate.pause();
    };
    const applying = f.study.work(f.job.id);
    await gate.waiting;
    try {
      f.rotate();
      telegramTrialRetention(f.trial, actor.communityId);
    } finally {
      gate.release();
    }
    await applying;
    const record = persisted<TelegramTrialRecord>(
      f,
      `trial:${actorKey(actor)}:${f.job.lessonId}`,
    );
    assert.equal(record.state.items.filter((item) => item.resolved).length, 0);
    assert.equal(f.current()?.state, "cancelled");
    assert.equal(
      persisted<number>(
        f,
        `trial-quota:${actorKey(actor)}:${f.job.reservedDay}`,
      ),
      1,
    );
    assert.equal(f.speechCalls(), 1);
  },
);

for (const initial of ["reserved", "dispatched"])
  test(
    `rotated unsent ${initial} work retries failed release and restores lane 5 capacity`,
    withLane5,
    async (t) => {
      const f = await fixture(t),
        resolve = f.ports.resolve;
      f.reserve();
      if (initial === "dispatched") await f.actual().dispatch(f.id);
      f.store.set(`speech-job:${f.job.id}`, {
        ...f.job,
        state: "dispatching",
        submissionStarted: false,
        audioDigest: f.payloadDigest,
        reservation: undefined,
      });
      let unavailable = true;
      f.ports.resolve = async (...args) => {
        if (unavailable) throw new Error("fixture_release_unavailable");
        return resolve(...args);
      };
      f.rotate();
      await f.bot.tick();
      assert.throws(
        () => f.reserve("another-trial"),
        /speech_trial_budget_exhausted/,
      );
      f.restart();
      await f.bot.tick();
      assert.equal(f.actual().get(f.id)?.state, initial);
      unavailable = false;
      await f.bot.tick();
      await f.bot.tick();
      assert.equal(f.actual().get(f.id)?.state, "refused");
      assert.doesNotThrow(() => f.reserve("another-trial"));
      assert.equal(f.current()?.state, "cancelled");
      assert.equal(f.speechCalls(), 0);
    },
  );

test(
  "reserve acknowledgement lost after cancellation still releases the late lane 5 row",
  withLane5,
  async (t) => {
    const f = await fixture(t),
      paused = barrier(),
      reserve = f.ports.reserve;
    f.ports.reserve = async (input) => {
      await paused.pause();
      await reserve(input);
      throw new Error("fixture_lost_reserve_reply");
    };
    const oldWorker = f.bot.tick();
    await paused.waiting;
    f.rotate();
    f.restart();
    await f.bot.tick();
    assert.equal(f.actual().get(f.id), null);
    paused.release();
    await oldWorker;
    f.restart();
    await f.bot.tick();
    await f.bot.tick();
    assert.equal(f.actual().get(f.id)?.state, "refused");
    assert.doesNotThrow(() => f.reserve("next-trial"));
    assert.equal(f.speechCalls(), 0);
  },
);

test(
  "provider unknown survives rotation and retention until exact status receipt settles",
  withLane5,
  async (t) => {
    const f = await fixture(t);
    f.fail("unknown");
    f.recoverReady(false);
    await f.bot.tick();
    assert.equal(f.speechCalls(), 1);
    f.rotate();
    f.restart();
    await f.bot.tick();
    f.advance(TELEGRAM_OPEN_MS + TELEGRAM_HISTORY_MS + 1);
    const held = telegramTrialRetention(f.trial, actor.communityId);
    assert.equal(held.erased, 0);
    assert.equal(held.recoveryHeld, 1);
    assert.equal(f.current()?.voice, null);
    assert.equal(f.current()?.submissionStarted, true);
    assert.ok(f.statusReads() > 0);
    f.recoverReady(true);
    f.restart();
    await f.bot.tick();
    assert.equal(f.actual().get(f.id)?.state, "succeeded");
    assert.equal(
      f.actual().get(f.id)?.evidenceDigest,
      digest(f.providerReceipts.get(f.job.id)),
    );
    assert.equal(f.current()?.state, "cancelled");
    assert.equal(f.current()?.grade, null);
    assert.equal(f.speechCalls(), 1);
    assert.equal(telegramTrialRetention(f.trial, actor.communityId).erased, 1);
  },
);

test(
  "lost release acknowledgement is confirmed by the terminal lane 5 row",
  withLane5,
  async (t) => {
    const f = await fixture(t),
      resolve = f.ports.resolve;
    f.reserve();
    await f.actual().dispatch(f.id);
    f.store.set("speech-job:" + f.job.id, {
      ...f.job,
      state: "dispatching",
      submissionStarted: false,
      audioDigest: f.payloadDigest,
      reservation: {
        keyGeneration: f.speech.config.keyGeneration,
        started: true,
      },
    });
    f.ports.resolve = async (...args) => {
      await resolve(...args);
      throw new Error("fixture_lost_release_reply");
    };
    f.rotate();
    await f.bot.tick();
    assert.equal(f.current()?.state, "releasing");
    assert.equal(f.actual().get(f.id)?.state, "refused");
    const evidence = f.actual().get(f.id)?.evidenceDigest;
    f.restart();
    await f.bot.tick();
    await f.bot.tick();
    assert.equal(f.current()?.state, "cancelled");
    assert.equal(f.current()?.resolution?.evidenceDigest, evidence);
    assert.equal(f.effects.length, 1);
    assert.doesNotThrow(() => f.reserve("replacement-trial"));
    assert.equal(f.speechCalls(), 0);
  },
);

test(
  "known rate refusal with a lost acknowledgement settles before its bounded retry",
  withLane5,
  async (t) => {
    const f = await fixture(t),
      resolve = f.ports.resolve;
    let lost = false;
    f.ports.resolve = async (id, state, evidence) => {
      const result = await resolve(id, state, evidence);
      if (state === "refused" && !lost) {
        lost = true;
        throw new Error("fixture_lost_refusal_reply");
      }
      return result;
    };
    f.fail("known_failed", "speech_rate_limited");
    await f.bot.tick();
    assert.equal(f.current()?.state, "settling");
    assert.equal(f.speechCalls(), 1);
    f.restart();
    await f.bot.tick();
    assert.equal(f.current()?.state, "retry_wait");
    assert.equal(f.speechCalls(), 1);
    f.advance(1000);
    f.fail(null);
    await f.bot.tick();
    assert.equal(f.speechCalls(), 2);
    assert.equal(f.study.session(actor).view.progress.resolved, 1);
    assert.deepEqual(
      f.effects
        .filter((effect) => effect.id === f.id)
        .map(({ state, evidence }) => ({ state, evidence })),
      Array.from({ length: 2 }, () => ({
        state: "refused",
        evidence: digest({ failure: "speech_rate_limited" }),
      })),
    );
  },
);

test(
  "expired voice with proven unsent admission journals release before dropping its handle",
  withLane5,
  async (t) => {
    const f = await fixture(t);
    f.reserve();
    await f.actual().dispatch(f.id);
    f.store.set("speech-job:" + f.job.id, {
      ...f.job,
      state: "dispatching",
      submissionStarted: false,
      audioDigest: f.payloadDigest,
      reservation: {
        keyGeneration: f.speech.config.keyGeneration,
        started: true,
      },
    });
    f.store.delete("job-ready:" + f.job.id);
    f.advance(25 * 3600_000);
    assert.equal(
      telegramTrialRetention(f.trial, actor.communityId).handlesErased,
      1,
    );
    assert.equal(f.current()?.voice, null);
    assert.equal(f.current()?.state, "releasing");
    f.restart();
    await f.bot.tick();
    assert.equal(f.actual().get(f.id)?.state, "refused");
    assert.equal(f.current()?.state, "cancelled");
    assert.equal(f.speechCalls(), 0);
  },
);

test(
  "a definitive first reserve rejection settles cancellation without a row",
  withLane5,
  async (t) => {
    const f = await fixture(t),
      paused = barrier(),
      reserve = f.ports.reserve;
    f.reserve("capacity-in-use");
    f.ports.reserve = async (input) => {
      await paused.pause();
      return reserve(input);
    };
    const oldWorker = f.bot.tick();
    await paused.waiting;
    f.rotate();
    f.restart();
    await f.bot.tick();
    assert.equal(f.current()?.state, "releasing");
    assert.equal(f.actual().get(f.id), null);
    paused.release();
    await oldWorker;
    assert.equal(f.current()?.state, "cancelled");
    assert.equal(f.actual().get(f.id), null);
    assert.equal(f.effects.length, 0);
    assert.equal(f.speechCalls(), 0);
  },
);
