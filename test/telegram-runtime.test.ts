import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramRuntime } from "../services/telegram-runtime.ts";
import { botFixture } from "./telegram-bot-fixture.ts";

test("ACK requires durable wake; failed wake retains one receipt and safe retry schedules it without provider work", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  let fail = true;
  const alarms: number[] = [];
  const runtime = telegramRuntime(
    f.bot,
    async (at) => {
      if (fail) throw new Error("simulated_alarm_failure");
      alarms.push(at);
    },
    f.now,
  );
  const request = () =>
    new Request("https://community.example/api/telegram/webhook", {
      method: "POST",
      headers: {
        "x-telegram-bot-api-secret-token": f.botOptions.webhookSecret,
      },
      body: JSON.stringify(f.message("/start", 900)),
    });
  assert.equal((await runtime.webhook(request())).status, 503);
  assert.equal(f.store.entries("update-ready:").length, 1);
  assert.equal(f.speechCalls(), 0);
  fail = false;
  assert.equal((await runtime.webhook(request())).status, 200);
  assert.equal(f.store.entries("update-ready:").length, 1);
  assert.equal(alarms[0], f.now());
  await runtime.tick();
  assert.equal(f.store.entries("update-ready:").length, 0);
  assert.ok(alarms.includes(f.now() + 15_000));
  assert.ok(f.sent.length > 0);
});

test("an invalid webhook does not arm work and a worker with no durable wake does no external work", async (t) => {
  const f = await botFixture();
  t.after(f.dispose);
  let alarms = 0;
  const runtime = telegramRuntime(
    f.bot,
    async () => {
      alarms++;
      throw new Error("unavailable");
    },
    f.now,
  );
  assert.equal(
    (
      await runtime.webhook(
        new Request("https://community.example/api/telegram/webhook", {
          method: "POST",
        }),
      )
    ).status,
    403,
  );
  assert.equal(alarms, 0);
  await f.webhook(f.message("/start", 901));
  await assert.rejects(runtime.tick(), /unavailable/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.speechCalls(), 0);
});
