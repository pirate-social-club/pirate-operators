import { test } from "node:test";
import assert from "node:assert/strict";
import { actor, account } from "./telegram-fixture.ts";
import { botFixture } from "./telegram-bot-fixture.ts";
import { barrier, connect } from "./telegram-repair1-fixture.ts";
import { TelegramBot } from "../services/telegram-bot.ts";
import {
  TelegramOutbox,
  type TelegramOutbound,
} from "../services/telegram-outbox.ts";
import {
  TelegramNotifications,
  telegramNoticePermitted,
  type TelegramNoticePort,
} from "../services/telegram-notifications.ts";
import { telegramTrialRetention } from "../services/telegram-retention.ts";

test("preference chosen value and receipt survive interruption and lease retry without a second toggle", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.command("/start");
  await f.command("/settings");
  const settings = f.sent.at(-1)!;
  assert.equal(settings.message.kind, "text");
  const token =
    settings.message.kind === "text"
      ? settings.message.buttons![0][0].data!
      : "";
  const update = {
    update_id: 90000,
    callback_query: {
      id: "settings-callback",
      from: { id: Number(actor.userId) },
      data: token,
      message: {
        message_id: settings.messageId,
        from: { id: Number(actor.botId), is_bot: true },
        chat: { id: Number(actor.userId), type: "private" },
      },
    },
  };
  await f.webhook(update);
  const key = f.store.entries<string>("update-ready:")[0].value,
    original = f.views.settings;
  f.views.settings = () => {
    throw new Error("crash_after_preference_commit");
  };
  await assert.rejects(
    f.bot.processUpdate(key),
    /crash_after_preference_commit/,
  );
  assert.equal(f.grants.preferences(actor).reminders, true);
  assert.deepEqual(f.store.get<any>(key).preferenceApplied, {
    key: "reminders",
    value: true,
  });
  f.views.settings = original;
  f.advance(31_000);
  await new TelegramBot(f.botOptions).tick();
  assert.equal(f.grants.preferences(actor).reminders, true);
  assert.equal(f.store.get<any>(key).state, "complete");
  await f.webhook(update);
  await f.bot.tick();
  assert.equal(f.grants.preferences(actor).reminders, true);
});

for (const change of [
  "preference",
  "unlink",
  "replacement",
  "late-account-read",
])
  test(`unsent notice rechecks ${change} after awaited authority`, async (t) => {
    const f = await botFixture();
    t.after(f.dispose);
    await f.command("/start");
    await connect(f);
    f.grants.setPreferences(actor, {
      reminders: true,
      rewards: true,
      dance: true,
    });
    const paused = barrier();
    let pauseRead = false;
    const notices: TelegramNoticePort = {
      async read(communityId, accountId, kind, eventId) {
        if (pauseRead) {
          pauseRead = false;
          await paused.pause();
        }
        return {
          communityId,
          accountId,
          kind,
          eventId,
          current: true,
          path: "/#wallet",
        };
      },
    };
    const outbox = new TelegramOutbox(f.grants, f.outbox.delivery, (a, g) =>
      telegramNoticePermitted(f.grants, notices, a, g),
    );
    await new TelegramNotifications(f.views, outbox, notices).account(
      actor,
      account.accountId,
      "claim_ready",
      "claim-paused",
    );
    if (change === "late-account-read") {
      const current = f.grants.accounts.current;
      let count = 0;
      f.grants.accounts.current = async (...args) => {
        if (++count === 3) await paused.pause();
        return current(...args);
      };
    } else pauseRead = true;
    const drain = outbox.drain(actor);
    await paused.waiting;
    if (change === "unlink") f.grants.unlink(actor, account.accountId);
    else if (change === "replacement")
      f.grants.configure({
        ...actor,
        botId: "90002",
        generation: 2,
        enabled: true,
      });
    else
      f.grants.setPreferences(actor, {
        reminders: true,
        rewards: false,
        dance: true,
      });
    paused.release();
    await drain;
    assert.equal(
      f.sent.some(
        (row) =>
          row.message.kind === "text" &&
          row.message.text === "A claim is available.",
      ),
      false,
    );
  });

test("completed export is lesson-guarded and all durable history copies are scrubbed after its window", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  for (let i = 0; i < 4; i++) await f.answer();
  const lessonId = f.study.session(actor).view.id;
  await f.command("/history");
  const document = f.store
    .entries<TelegramOutbound>("outbox:")
    .find((row) => row.value.payload.kind === "document")!;
  assert.equal(document.value.sessionId, lessonId);
  assert.equal(document.value.state, "sent");
  f.advance(31 * 86400_000);
  assert.equal(telegramTrialRetention(f.trial, actor.communityId).erased, 1);
  assert.notEqual(
    f.store.get<TelegramOutbound>(document.key)?.payload.kind,
    "document",
  );
  assert.equal(
    f.store
      .entries<TelegramOutbound>("outbox:")
      .some((row) => row.value.payload.kind === "document"),
    false,
  );
});

for (const failed of [false, true])
  test(`expiration scrubs an unindexed legacy export while an in-flight ${failed ? "failure" : "receipt"} returns`, async (t) => {
    const f = await botFixture();
    t.after(f.dispose);
    await f.command("/start");
    const paused = barrier();
    const outbox = new TelegramOutbox(f.grants, {
      async send() {
        await paused.pause();
        if (failed) throw new Error("unknown_delivery");
        return { messageId: 999 };
      },
    });
    outbox.enqueue(actor, "old-private-export", {
      kind: "document",
      filename: "private.json",
      content: "PRIVATE_EXPORT_SENTINEL",
      expiresAt: f.now() + 1000,
    });
    const key = f.store
      .entries<TelegramOutbound>("outbox:")
      .find((row) => row.value.effectId === "old-private-export")!.key;
    const drain = outbox.drain(actor);
    await paused.waiting;
    f.advance(1001);
    telegramTrialRetention(f.trial, actor.communityId);
    assert.notEqual(
      f.store.get<TelegramOutbound>(key)?.payload.kind,
      "document",
    );
    paused.release();
    await drain;
    const row = f.store.get<TelegramOutbound>(key)!;
    assert.equal(
      JSON.stringify(row).includes("PRIVATE_EXPORT_SENTINEL"),
      false,
    );
    assert.equal(row.state, failed ? "unknown" : "sent");
    assert.ok(
      row.payloadDigest,
      "minimal receipt/digest survives payload scrubbing",
    );
  });

test("expired export is not restored by a paused authority refusal or late enqueue", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.command("/start");
  const grant = await connect(f),
    paused = barrier(),
    current = f.grants.accounts.current;
  f.outbox.enqueue(
    actor,
    "export-auth-pause",
    {
      kind: "document",
      filename: "private.json",
      content: "PRIVATE_AUTH_EXPORT",
      expiresAt: f.now() + 1000,
    },
    { grantId: grant.id, authorityVersion: grant.authorityVersion },
  );
  let once = true;
  f.grants.accounts.current = async (...args) => {
    if (once) {
      once = false;
      await paused.pause();
    }
    return current(...args);
  };
  const drain = f.outbox.drain(actor);
  await paused.waiting;
  f.advance(1001);
  telegramTrialRetention(f.trial, actor.communityId);
  paused.release();
  await drain;
  f.outbox.enqueue(actor, "export-late-enqueue", {
    kind: "document",
    filename: "private.json",
    content: "PRIVATE_AUTH_EXPORT",
    expiresAt: f.now() - 1,
  });
  assert.equal(
    f.store
      .entries<TelegramOutbound>("outbox:")
      .some((row) => JSON.stringify(row.value).includes("PRIVATE_AUTH_EXPORT")),
    false,
  );
});
