import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { telegramApi } from "../services/telegram-api.ts";
import { actor } from "./telegram-fixture.ts";
import { voiceBytes } from "./telegram-bot-fixture.ts";
import { readStudyAudio } from "../services/study-spoken.ts";

const config = {
  botId: actor.botId,
  botToken: actor.botId + ":local_fixture_bot_token_123456789",
  communityOrigin: "https://community.example",
};
const audio = {
  url:
    "https://community.example/api/public/posts/0x" + "b".repeat(64) + "/audio",
  filename: "midnight-waves.mp3",
  byteLength: voiceBytes.length,
  sha256: sha256(voiceBytes),
};
test("download rechecks exact public bytes/hash and uploads the intended filename as native song audio", async () => {
  let uploaded: File | null = null,
    calls = 0;
  const api = telegramApi(config, (async (url, init) => {
    calls++;
    if (String(url).startsWith(config.communityOrigin))
      return new Response(voiceBytes);
    assert.ok(String(url).endsWith("/sendAudio"));
    const form = init!.body as FormData;
    uploaded = form.get("audio") as File;
    assert.equal(form.get("chat_id"), actor.chatId);
    return Response.json({ ok: true, result: { message_id: 10 } });
  }) as typeof fetch);
  await api.send(actor, { kind: "song", title: "Midnight Waves", audio });
  assert.equal(calls, 2);
  assert.equal((uploaded as unknown as File).name, "midnight-waves.mp3");
  assert.deepEqual(
    new Uint8Array(await (uploaded as unknown as File).arrayBuffer()),
    voiceBytes,
  );
});
test("private resources, redirect responses, wrong digests and cross-origin audio never reach sendAudio", async () => {
  for (const changed of [
    { ...audio, url: "https://community.example/api/private/stems/audio" },
    { ...audio, url: "https://attacker.example/file" },
    { ...audio, sha256: "0x" + "0".repeat(64) },
  ]) {
    const calls: string[] = [];
    const api = telegramApi(config, (async (url) => {
      calls.push(String(url));
      return new Response(voiceBytes);
    }) as typeof fetch);
    await assert.rejects(
      api.send(actor, { kind: "song", title: "Song", audio: changed }),
      /public_audio_unavailable/,
    );
    assert.equal(
      calls.some((url) => url.includes("api.telegram.org")),
      false,
    );
  }
  const api = telegramApi(
    config,
    (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example" },
      })) as typeof fetch,
  );
  await assert.rejects(
    api.send(actor, { kind: "song", title: "Song", audio }),
    /public_audio_unavailable/,
  );
});
test("voice download is bounded, scoped to the configured bot and validates the Ogg container before grading", async () => {
  const api = telegramApi(config, (async (url) =>
    String(url).includes("/getFile")
      ? Response.json({
          ok: true,
          result: {
            file_path: "voice/answer.oga",
            file_size: voiceBytes.length,
            file_unique_id: "unique",
          },
        })
      : new Response(voiceBytes)) as typeof fetch);
  const voice = {
    fileId: "fixture-voice",
    fileUniqueId: "unique",
    durationMs: 4000,
    contentType: "audio/ogg",
    reportedBytes: voiceBytes.length,
  };
  assert.equal(
    (await readStudyAudio(await api.read(actor, voice))).audio.length,
    voiceBytes.length,
  );
  await assert.rejects(
    api.read({ ...actor, botId: "99999" }, voice),
    /wrong_bot/,
  );
  await assert.rejects(
    api.read(actor, { ...voice, reportedBytes: 524289 }),
    /voice_invalid/,
  );
});
test("Telegram delivery errors expose only bounded status, never a managed token or provider response", async () => {
  const api = telegramApi(config, (async () =>
    Response.json(
      {
        ok: false,
        error_code: 429,
        description: config.botToken,
        parameters: { retry_after: 2 },
      },
      { status: 429 },
    )) as typeof fetch);
  try {
    await api.send(actor, { kind: "text", text: "Hello" });
    assert.fail("expected refusal");
  } catch (error) {
    assert.equal((error as { outcome: string }).outcome, "known_failed");
    assert.equal(String(error).includes(config.botToken), false);
  }
});
