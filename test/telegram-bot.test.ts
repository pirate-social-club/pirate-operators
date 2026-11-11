import { test } from "node:test";
import assert from "node:assert/strict";
import { botFixture } from "./telegram-bot-fixture.ts";
import { actor } from "./telegram-fixture.ts";
import { actorKey } from "../packages/telegram/contracts.ts";
import { TelegramBot } from "../services/telegram-bot.ts";

test("start shows songs immediately; one tap starts a native prompt/audio with no account/provider request", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  const selected = await f.choose();
  assert.equal(selected.response.status, 200);
  assert.equal(f.speechCalls(), 0);
  assert.equal(f.linkedCalls(), 0);
  const text = f.sent
    .filter((item) => item.message.kind === "text")
    .map((item) => (item.message as { text: string }).text);
  assert.ok(text[0].startsWith("Songs"));
  assert.ok(text[1].startsWith("Say it back:"));
  assert.equal(
    text.some((value) =>
      /Choose a song to study|voice-access|consent|trial screen|English/.test(
        value,
      ),
    ),
    false,
  );
  assert.ok(f.sent.some((item) => item.message.kind === "pin"));
  assert.ok(f.sent.some((item) => item.message.kind === "voice"));
  assert.equal(f.grants.read(actor), undefined);
});
test("a complete signup-free trial uses the established queue/grader and never publishes or credits an account", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  for (let i = 0; i < 4; i++) await f.answer();
  const view = f.study.session(actor).view;
  assert.equal(view.status, "completed");
  assert.equal(view.score, 100);
  assert.equal(f.speechCalls(), 4);
  assert.equal(f.linkedCalls(), 0);
  assert.equal(f.grants.read(actor), undefined);
  const result = f.sent.findLast(
    (item) =>
      item.message.kind === "text" &&
      item.message.text.startsWith("Great work"),
  )!;
  assert.ok(result);
  assert.equal((result.message as { text: string }).text, "Great work! 100%");
  assert.ok(
    f.reservations.size === 4 &&
      [...f.reservations.values()].every(
        (row) => row.channel === "telegram-trial",
      ),
  );
});
test("duplicate and racing delivery grades once; verdict is delivered before the next prompt", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const update = f.voiceUpdate();
  await Promise.all([f.webhook(update), f.webhook(update)]);
  await Promise.all([f.bot.tick(), f.bot.tick()]);
  await f.bot.tick();
  assert.equal(f.speechCalls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
  const text = f.sent
    .filter((item) => item.message.kind === "text")
    .map((item) => (item.message as { text: string }).text);
  const verdict = text.indexOf("Correct");
  assert.ok(verdict > 0 && text[verdict + 1].startsWith("Say it back:"));
  assert.equal(text.filter((value) => value === "Correct").length, 1);
});
test("wrong webhook secret, group/user mismatch, forwarded voice and wrong bot are rejected before speech", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const voice = f.voiceUpdate();
  assert.equal((await f.webhook(voice, "wrong-secret")).status, 403);
  assert.equal(
    (
      await f.webhook({
        ...voice,
        message: {
          ...voice.message,
          chat: { id: Number(actor.userId), type: "group" },
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.webhook({
        ...voice,
        message: { ...voice.message, from: { id: 123 } },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.webhook({
        ...voice,
        message: { ...voice.message, forward_origin: { type: "user" } },
      })
    ).status,
    403,
  );
  await f.bot.tick();
  assert.equal(f.speechCalls(), 0);
});
test("ambiguous and stale voice replies cannot be assigned to a different prompt", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const old = f.voiceUpdate();
  await f.answer();
  const delayed = {
    ...old,
    update_id: old.update_id + 100,
    message: {
      ...old.message,
      voice: { ...old.message.voice, file_id: "delayed" },
    },
  };
  assert.equal((await f.webhook(delayed)).status, 200);
  await f.bot.tick();
  assert.equal(f.speechCalls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
  assert.ok(
    f.sent.some(
      (item) =>
        item.message.kind === "text" &&
        /current lesson line/.test(item.message.text),
    ),
  );
});
test("admission refusal and known speech failure preserve prompt/progress and counted takes", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const before = f.study.session(actor).view;
  f.admission(false);
  await f.answer();
  assert.equal(f.speechCalls(), 0);
  assert.equal(f.study.session(actor).view.prompt?.key, before.prompt?.key);
  f.admission(true);
  f.fail("known_failed");
  await f.answer();
  assert.equal(f.study.session(actor).view.progress.resolved, 0);
  assert.equal(f.study.session(actor).view.prompt?.take, before.prompt?.take);
  f.fail(null);
  await f.answer();
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
});
test("429 retries are bounded with backoff and never consume a learner take", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  f.fail("known_failed", "speech_rate_limited");
  await f.answer();
  assert.equal(f.speechCalls(), 1);
  await f.bot.tick();
  assert.equal(f.speechCalls(), 1);
  f.advance(1000);
  await f.bot.tick();
  assert.equal(f.speechCalls(), 2);
  assert.equal(f.study.session(actor).view.progress.resolved, 0);
  assert.equal(f.study.session(actor).view.prompt?.take, 1);
  await f.bot.tick();
  assert.equal(f.speechCalls(), 2);
});
test("uncertain speech uses receipt recovery after worker restart without resubmission", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  f.fail("unknown");
  f.recoverReady(false);
  await f.answer();
  assert.equal(f.speechCalls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 0);
  const restarted = new TelegramBot(f.botOptions);
  await restarted.tick();
  assert.equal(f.speechCalls(), 1);
  f.recoverReady(true);
  await restarted.tick();
  assert.equal(f.speechCalls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
});
test("partial trial progress survives a SQLite snapshot restart and has no idle reset", async (t) => {
  const first = await botFixture();
  await first.choose();
  await first.answer();
  const id = first.study.session(actor).view.id;
  const snapshot = first.database
    .prepare("SELECT key,value FROM telegram_journal")
    .all() as { key: string; value: string }[];
  first.dispose();
  const second = await botFixture({ snapshot });
  t.after(second.dispose);
  second.advance(2 * 86400_000);
  const view = await second.study.resume(actor);
  assert.equal(view.id, id);
  assert.equal(view.progress.resolved, 1);
  assert.equal(second.speechCalls(), 0);
});
test("per-user trial cap bounds usage without inventing reward entitlement", async (t) => {
  const f = await botFixture({ dailySpeech: 1 });
  t.after(f.dispose);
  await f.choose();
  await f.answer();
  await f.answer();
  assert.equal(f.speechCalls(), 1);
  assert.equal(f.study.session(actor).view.progress.resolved, 1);
  assert.equal(f.store.entries("grant:").length, 0);
});
test("song download sends the public song and offer reads distinguish unavailable from no offer", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  await f.command("/download");
  const download = f.sent.find((item) => item.message.kind === "song")!;
  assert.ok(
    download.message.kind === "song" &&
      download.message.audio.filename === "song.mp3",
  );
  await f.command("/rewards");
  assert.ok(
    f.sent.some(
      (item) =>
        item.message.kind === "text" &&
        /testnet/.test(item.message.text) &&
        /Trial lessons do not earn/.test(item.message.text),
    ),
  );
  f.offersAvailable(false);
  await f.command("/rewards");
  assert.ok(
    f.sent.some(
      (item) =>
        item.message.kind === "text" &&
        /Reward information is unavailable/.test(item.message.text),
    ),
  );
});
test("unknown message delivery holds ordered work until retained receipt is reconciled", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  f.deliveryMode("unknown");
  await f.command("/start");
  assert.equal(f.sent.length, 1);
  f.advance(1000);
  await f.bot.tick();
  await f.bot.tick();
  assert.equal(
    f.sent.filter((item) => item.message.kind === "text" && item.message.home)
      .length,
    1,
  );
  assert.ok(f.sent.some((item) => item.message.kind === "pin"));
});
test("bot rotation cancels queued old-generation voice before a paid call", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  const update = f.voiceUpdate();
  await f.webhook(update);
  f.grants.configure({ ...actor, generation: 2, enabled: true });
  await f.bot.tick();
  assert.equal(f.speechCalls(), 0);
});
test("completed history remains downloadable for 30 days and stays private/unrewarded", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  await f.choose();
  for (let i = 0; i < 4; i++) await f.answer();
  const id = f.study.session(actor).view.id;
  f.advance(29 * 86400_000);
  const history = f.trial.history(actor, id);
  assert.equal(history.publication, "never");
  assert.equal(history.rewards, "none");
  f.advance(2 * 86400_000);
  assert.throws(() => f.trial.history(actor, id), /history_expired/);
  assert.equal(
    f.store.get<number>(
      `trial-quota:${actorKey(actor)}:${Math.floor(f.now() / 86400_000)}`,
    ),
    undefined,
  );
});
