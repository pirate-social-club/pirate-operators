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
} from "../packages/telegram/contracts.ts";
import { digest } from "../packages/protocol/index.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";

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

async function fixture(t: import("node:test").TestContext) {
  const f = await botFixture(),
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
