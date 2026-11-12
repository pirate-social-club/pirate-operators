import test from "node:test";
import assert from "node:assert/strict";
import { parseTelegramUpdate } from "../packages/telegram/updates.ts";
import { telegramStudyFacts } from "../packages/study/telegram-publication.ts";
import { digest } from "../packages/protocol/index.ts";

const registration = Object.freeze({
  communityId: "0x" + "a".repeat(64),
  botId: "90001",
  generation: 1,
  enabled: true,
});
const actor = {
  communityId: registration.communityId,
  botId: registration.botId,
  generation: 1,
  userId: "70001",
  chatId: "70001",
};
const message = {
  message_id: 1001,
  chat: { id: 70001, type: "private" },
  from: { id: 70001 },
};
const facts = (value: unknown) =>
  telegramStudyFacts({
    schema: "pirate.study.telegram-publication-fence/1",
    version: 1,
    grantId: "fixture_verified_grant_0001",
    accountId: "fixture_account",
    authorityVersion: "fixture_authority",
    actor: value,
  });

// UNRUN. Baseline bddd spreads enabled into each actor and fails strict facts.
// The exact production proposal projects scope; fence validation stays strict.
for (const [kind, value] of [
  ["command", { update_id: 1, message: { ...message, text: "/start" } }],
  [
    "callback",
    {
      update_id: 2,
      callback_query: {
        id: "fixture_callback",
        from: message.from,
        data: "a".repeat(43),
        message: { ...message, from: { id: 90001, is_bot: true } },
      },
    },
  ],
  [
    "voice",
    {
      update_id: 3,
      message: {
        ...message,
        reply_to_message: {
          message_id: 1000,
          from: { id: 90001, is_bot: true },
        },
        voice: {
          file_id: "fixture_voice",
          file_unique_id: "fixture_unique",
          duration: 4,
          file_size: 12,
          mime_type: "audio/ogg",
        },
      },
    },
  ],
] as const) {
  test(`actual registered-bot ${kind} produces the exact strict private Study actor`, () => {
    const update = parseTelegramUpdate(value, registration);
    assert.equal(update.kind, kind);
    assert.deepEqual(update.actor, actor);
    assert.equal("enabled" in update.actor, false);
    assert.equal(digest(facts(update.actor)), digest(facts(actor)));
    assert.equal(registration.enabled, true);
  });
}

test("the shared fence still rejects an actor carrying registration fields", () => {
  assert.throws(() => facts({ ...actor, enabled: true }), /invalid_fields/);
});

test("scope projection validates community and generation instead of trusting extra fields", () => {
  assert.throws(
    () =>
      parseTelegramUpdate(
        { update_id: 1, message: { ...message, text: "/start" } },
        { ...registration, generation: 0 },
      ),
    /telegram_generation_invalid/,
  );
  assert.throws(
    () =>
      parseTelegramUpdate(
        { update_id: 1, message: { ...message, text: "/start" } },
        { ...registration, communityId: "invalid" },
      ),
    /telegram_community_invalid/,
  );
});
