import { test } from "node:test";
import assert from "node:assert/strict";
import { botFixture } from "./telegram-bot-fixture.ts";
import { actor, account } from "./telegram-fixture.ts";
import {
  actorKey,
  TELEGRAM_HISTORY_MS,
  TELEGRAM_OPEN_MS,
} from "../packages/telegram/contracts.ts";
import {
  telegramTrialRetention,
  TELEGRAM_VOICE_HANDLE_MS,
} from "../services/telegram-retention.ts";
import {
  TelegramNotifications,
  telegramNoticePermitted,
  type TelegramNoticePort,
} from "../services/telegram-notifications.ts";
import { TelegramOutbox } from "../services/telegram-outbox.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";

test("completion does not erase private history; eligible cleanup erases content and leaves minimal dedup facts", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  for (let i = 0; i < 4; i++) await f.answer();
  const id = f.study.session(actor).view.id;
  assert.equal(telegramTrialRetention(f.trial, actor.communityId).erased, 0);
  assert.equal(f.trial.history(actor, id).lesson.status, "completed");
  f.advance(TELEGRAM_HISTORY_MS - 1);
  assert.equal(telegramTrialRetention(f.trial, actor.communityId).erased, 0);
  f.advance(2);
  assert.equal(telegramTrialRetention(f.trial, actor.communityId).erased, 1);
  assert.throws(() => f.trial.history(actor, id), /history_expired/);
  assert.equal(f.store.entries("speech-job:").length, 0);
  assert.equal(f.store.entries("job-tombstone:").length, 4);
  await f.choose();
  assert.notEqual(f.study.session(actor).view.id, id);
  assert.equal(f.study.session(actor).view.progress.resolved, 0);
});
test("open lessons close at 30d and retain another 30d; history and resume have separate lifetimes", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  await f.answer();
  const id = f.study.session(actor).view.id;
  f.advance(TELEGRAM_OPEN_MS);
  const view = f.trial.get(actor, id);
  assert.equal(view.status, "abandoned");
  assert.equal(view.progress.resolved, 1);
  assert.equal(f.trial.history(actor, id).lesson.status, "abandoned");
  assert.equal(telegramTrialRetention(f.trial, actor.communityId).erased, 0);
  f.advance(TELEGRAM_HISTORY_MS + 1);
  assert.equal(telegramTrialRetention(f.trial, actor.communityId).erased, 1);
});
test("uncertain provider recovery holds private-history erasure but file handles expire separately", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  f.fail("unknown");
  f.recoverReady(false);
  await f.answer();
  f.advance(TELEGRAM_VOICE_HANDLE_MS);
  const first = telegramTrialRetention(f.trial, actor.communityId);
  assert.equal(first.handlesErased, 1);
  const job = f.store.entries<TelegramStudyWork>("speech-job:")[0].value;
  assert.equal(job.voice, null);
  assert.equal(job.durationMs, 4000);
  f.advance(TELEGRAM_OPEN_MS + TELEGRAM_HISTORY_MS);
  const later = telegramTrialRetention(f.trial, actor.communityId);
  assert.equal(later.erased, 0);
  assert.equal(later.recoveryHeld, 1);
});
test("saved assessment is reconciled before the open-bound close after interruption", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const update = f.voiceUpdate();
  await f.webhook(update);
  for (const row of f.store.entries<string>("update-ready:"))
    await f.bot.processUpdate(row.value);
  const job = f.store.entries<TelegramStudyWork>("speech-job:")[0].value;
  await f.speech.work(job.id);
  f.advance(TELEGRAM_OPEN_MS);
  const view = f.trial.get(actor, job.lessonId);
  assert.equal(view.progress.resolved, 1);
  assert.equal(view.status, "abandoned");
});
test("reminders are opt-in and can work for a trial sender without creating an account", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const notices: TelegramNoticePort = {
    read: async () => {
      throw new Error("not_needed_for_guest_reminder");
    },
  };
  const outbox = new TelegramOutbox(f.grants, f.outbox.delivery, (a, guard) =>
    telegramNoticePermitted(f.grants, notices, a, guard),
  );
  const notifications = new TelegramNotifications(f.views, outbox, notices);
  await assert.rejects(
    notifications.reminder(actor, "day-one"),
    /notifications_disabled/,
  );
  f.grants.setPreferences(actor, {
    reminders: true,
    rewards: false,
    dance: false,
  });
  await notifications.reminder(actor, "day-one");
  await notifications.reminder(actor, "day-one");
  await outbox.drain(actor);
  assert.equal(
    f.sent.filter(
      (item) =>
        item.message.kind === "text" &&
        item.message.text === "Ready to practise?",
    ).length,
    1,
  );
  assert.equal(f.grants.read(actor), undefined);
});
test("personal notices deduplicate and recheck preferences, link and current source before delivery", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const flow = await f.begin();
  await f.complete(flow, await f.verify(flow));
  let current = true;
  const notices: TelegramNoticePort = {
    read: async (communityId, accountId, kind, eventId) => ({
      communityId,
      accountId,
      kind,
      eventId,
      current,
      path: "/#wallet",
    }),
  };
  const outbox = new TelegramOutbox(f.grants, f.outbox.delivery, (a, guard) =>
    telegramNoticePermitted(f.grants, notices, a, guard),
  );
  const notifications = new TelegramNotifications(f.views, outbox, notices);
  f.grants.setPreferences(actor, {
    reminders: true,
    rewards: true,
    dance: true,
  });
  await notifications.account(
    actor,
    account.accountId,
    "claim_ready",
    "claim-one",
  );
  await notifications.account(
    actor,
    account.accountId,
    "claim_ready",
    "claim-one",
  );
  await outbox.drain(actor);
  assert.equal(
    f.sent.filter(
      (item) =>
        item.message.kind === "text" &&
        item.message.text === "A claim is available.",
    ).length,
    1,
  );
  await notifications.account(
    actor,
    account.accountId,
    "dance_reviewed",
    "dance-one",
  );
  current = false;
  await outbox.drain(actor);
  assert.equal(
    f.sent.filter(
      (item) =>
        item.message.kind === "text" &&
        item.message.text === "Your Dance review is ready.",
    ).length,
    0,
  );
  current = true;
  await notifications.account(
    actor,
    account.accountId,
    "claim_ready",
    "claim-two",
  );
  f.grants.unlink(actor, account.accountId);
  await outbox.drain(actor);
  assert.equal(
    f.sent.filter(
      (item) =>
        item.message.kind === "text" &&
        item.message.text === "A claim is available.",
    ).length,
    1,
  );
});
test("switching off a preference after enqueue fences the unsent notice", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const notices: TelegramNoticePort = {
    read: async () => {
      throw new Error("unused");
    },
  };
  const outbox = new TelegramOutbox(f.grants, f.outbox.delivery, (a, guard) =>
    telegramNoticePermitted(f.grants, notices, a, guard),
  );
  const notifications = new TelegramNotifications(f.views, outbox, notices);
  f.grants.setPreferences(actor, {
    reminders: true,
    rewards: false,
    dance: false,
  });
  await notifications.reminder(actor, "one");
  f.grants.setPreferences(actor, {
    reminders: false,
    rewards: false,
    dance: false,
  });
  await outbox.drain(actor);
  assert.equal(
    f.sent.some(
      (item) =>
        item.message.kind === "text" &&
        item.message.text === "Ready to practise?",
    ),
    false,
  );
  assert.ok(f.store.get(`preferences:${actorKey(actor)}`));
});
