import { sha256 } from "viem";
import { actor, linkFixture } from "./telegram-fixture.ts";
import { TelegramTrialLessons } from "../services/telegram-trial.ts";
import {
  TelegramTrialSpeech,
  type TelegramSpeechAdmission,
} from "../services/telegram-speech.ts";
import { TelegramStudyService } from "../services/telegram-study.ts";
import { TelegramOutbox } from "../services/telegram-outbox.ts";
import { TelegramBotViews } from "../services/telegram-bot-view.ts";
import { TelegramBot } from "../services/telegram-bot.ts";
import {
  TelegramDeliveryError,
  type TelegramNativeMessage,
} from "../packages/telegram/messages.ts";
import type {
  TelegramCatalogPort,
  TelegramLinkedStudyPort,
} from "../packages/telegram/study-contracts.ts";
import { StudySpeechError } from "../packages/study/speech-transcriber.ts";
import type { StudyLine } from "../packages/study/contracts.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";

export const voiceBytes = new Uint8Array([
  79, 103, 103, 83, 0, 0, 0, 0, 0, 0, 0, 1,
]);
export async function botFixture(
  options: {
    path?: string;
    dailySpeech?: number;
    providerReceipts?: Map<string, { text: string; language: string }>;
    snapshot?: { key: string; value: string }[];
  } = {},
) {
  const f = await linkFixture(options.path, options.snapshot),
    { grants } = f;
  const song = {
    chainId: 6343,
    postsContract: "0x" + "2".repeat(40),
    communityId: actor.communityId,
    postId: "0x" + "b".repeat(64),
    lyricRevision: 1,
  };
  const lines: StudyLine[] = [
    "I hear the waves calling me home",
    "And the light is low",
    "The morning carries a quiet song",
    "We follow the rhythm of the sea",
  ].map((text, i) => ({
    ...song,
    text,
    language: "en",
    lineId: "0x" + String(i + 1).repeat(64),
    lineVersion: 1,
    manifestDigest: "0x" + "d".repeat(64),
  }));
  const publicAudio = {
    url: "https://community.example/api/public/posts/" + song.postId + "/audio",
    filename: "song.mp3",
    byteLength: voiceBytes.length,
    sha256: sha256(voiceBytes),
  };
  let offersAvailable = true,
    linkedCalls = 0,
    heard: string | null = null,
    speechCalls = 0,
    failure: "known_failed" | "unknown" | null = null;
  let speechCode = "speech_unavailable",
    recoverReady = true,
    admissionAvailable = true,
    sendMode: "normal" | "unknown" | "blocked" = "normal";
  let messageSequence = 100,
    updateSequence = 1,
    sendCalls = 0;
  const providerReceipts =
    options.providerReceipts ??
    new Map<string, { text: string; language: string }>();
  const catalog: TelegramCatalogPort = {
    async list(who, grant) {
      return {
        songs: [await catalog.song(who, "song-one", grant)],
        drawAt: f.now() + 86_400_000,
      };
    },
    async song(who, key, grant) {
      if (key !== "song-one" || who.communityId !== actor.communityId)
        throw new Error("song_not_found");
      return {
        key,
        title: "Midnight Waves",
        song,
        publicAudio,
        offers: offersAvailable
          ? {
              state: "ready",
              readAt: f.now(),
              validUntil: f.now() + 60_000,
              offers: [
                {
                  id: "offer-one",
                  mode: "testnet",
                  opensAt: f.now() - 1000,
                  cutoffAt: f.now() + 86_400_000,
                  tickets: 6,
                  activities: ["study"],
                  rules: "Qualifying learners share any winnings.",
                },
              ],
            }
          : { state: "unavailable" },
        streak: grant ? 12 : null,
        resumable: false,
      };
    },
    lines: async () => lines,
    referenceAudio: async () => ({ ...publicAudio, filename: "reference.ogg" }),
  };
  const reservations = new Map<
    string,
    { state: string; payloadDigest: string; channel: string }
  >();
  const admission: TelegramSpeechAdmission = {
    reserve(input) {
      if (!admissionAvailable) throw new Error("speech_trial_budget_exhausted");
      const previous = reservations.get(input.requestId);
      if (previous && previous.payloadDigest !== input.payloadDigest)
        throw new Error("admission_changed");
      if (!previous)
        reservations.set(input.requestId, {
          state: "reserved",
          payloadDigest: input.payloadDigest,
          channel: input.channel,
        });
    },
    dispatch(id) {
      const row = reservations.get(id)!;
      if (row.state !== "reserved")
        return { dispatch: false, reservation: row };
      row.state = "dispatched";
      return { dispatch: true, reservation: row };
    },
    get: (id) => reservations.get(id),
    resolve(id, state) {
      const row = reservations.get(id);
      if (row) row.state = state;
    },
  };
  const files = {
    async read() {
      return new Request("https://audio.invalid/answer", {
        method: "PUT",
        headers: { "content-type": "audio/ogg", "x-study-duration-ms": "4000" },
        body: voiceBytes,
      });
    },
  };
  const transcriber = {
    providerRetention: "stored" as const,
    async transcribe(_audio, _type, _language, context) {
      speechCalls++;
      const transcript = {
        text:
          heard ?? lines.find((line) => line.lineId === context?.lineId)!.text,
        language: "en",
      };
      if (failure === "unknown") {
        providerReceipts.set(context!.attemptId, transcript);
        throw new StudySpeechError(speechCode, "unknown");
      }
      if (failure === "known_failed")
        throw new StudySpeechError(speechCode, "known_failed");
      providerReceipts.set(context!.attemptId, transcript);
      return transcript;
    },
    async recover(context) {
      const transcript = providerReceipts.get(context.attemptId);
      return recoverReady && transcript
        ? { state: "assessed" as const, transcript }
        : null;
    },
  } satisfies import("../packages/study/speech-transcriber.ts").StudyTranscriber;
  const trial = new TelegramTrialLessons(grants, catalog, {
    perUserDailySpeech: options.dailySpeech ?? 20,
    maxOpenLessons: 3,
  });
  const linked: TelegramLinkedStudyPort = Object.fromEntries(
    ["start", "get", "answer", "recover", "personal"].map((key) => [
      key,
      async () => {
        linkedCalls++;
        throw new Error("fixture_unexpected_connected_call");
      },
    ]),
  ) as unknown as TelegramLinkedStudyPort;
  let study: TelegramStudyService;
  const speech = new TelegramTrialSpeech({
    store: f.store,
    config: { communityId: actor.communityId, keyGeneration: "fixture-key-1" },
    admission,
    transcriber,
    files,
    permit: (job) => study.permit(job as TelegramStudyWork),
    beforeSubmission: (job) => study.beforeSubmission(job as TelegramStudyWork),
    now: f.now,
  });
  study = new TelegramStudyService({
    grants,
    trial,
    speech,
    linked,
    files,
    catalog,
  });
  const sent: {
      message: TelegramNativeMessage;
      messageId: number;
      effectId?: string;
    }[] = [],
    deliveryReceipts = new Map<string, { messageId: number }>();
  const delivery = {
    async send(_who, message, target, effectId) {
      sendCalls++;
      if (sendMode === "blocked")
        throw new TelegramDeliveryError(
          "telegram_bot_blocked",
          "known_failed",
          1000,
          true,
        );
      const messageId =
        message.kind === "pin"
          ? target!
          : message.kind === "text" && message.editMessageId
            ? message.editMessageId
            : ++messageSequence;
      sent.push({ message: structuredClone(message), messageId, effectId });
      if (effectId) deliveryReceipts.set(effectId, { messageId });
      if (sendMode === "unknown") {
        sendMode = "normal";
        throw new TelegramDeliveryError(
          "simulated_unknown_delivery",
          "unknown",
        );
      }
      return { messageId };
    },
    recover: async (id) => deliveryReceipts.get(id) ?? null,
  } satisfies import("../packages/telegram/messages.ts").TelegramDeliveryPort;
  const outbox = new TelegramOutbox(grants, delivery),
    views = new TelegramBotViews({
      linking: f.linking,
      study,
      catalog,
      linked,
      origin: "https://community.example",
    });
  const botOptions = {
      views,
      outbox,
      scope: actor,
      webhookSecret: "local_fixture_webhook_secret_123456789",
    },
    bot = new TelegramBot(botOptions);
  async function webhook(value: unknown, secret = botOptions.webhookSecret) {
    return bot.webhook(
      new Request("https://community.example/api/telegram/webhook", {
        method: "POST",
        headers: {
          "x-telegram-bot-api-secret-token": secret,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      }),
    );
  }
  const message = (text: string, id = updateSequence++) => ({
    update_id: id,
    message: {
      message_id: 1000 + id,
      chat: { id: Number(actor.userId), type: "private" },
      from: { id: Number(actor.userId) },
      text,
    },
  });
  async function command(text: string) {
    const update = message(text),
      response = await webhook(update);
    await bot.tick();
    return { response, update };
  }
  async function choose() {
    await command("/start");
    const home = sent.findLast(
      (item) => item.message.kind === "text" && item.message.home,
    )!;
    const token =
      home.message.kind === "text" ? home.message.buttons![1][0].data! : "";
    const id = updateSequence++;
    const update = {
      update_id: id,
      callback_query: {
        id: "callback-" + id,
        from: { id: Number(actor.userId) },
        data: token,
        message: {
          message_id: home.messageId,
          from: { id: Number(actor.botId), is_bot: true },
          chat: { id: Number(actor.userId), type: "private" },
        },
      },
    };
    const response = await webhook(update);
    await bot.tick();
    return { response, update };
  }
  function voiceUpdate(id = updateSequence++) {
    const prompt = sent.findLast(
      (item) =>
        (item.message.kind === "text" || item.message.kind === "voice") &&
        item.message.promptKey,
    )!;
    return {
      update_id: id,
      message: {
        message_id: 1000 + id,
        chat: { id: Number(actor.userId), type: "private" },
        from: { id: Number(actor.userId) },
        reply_to_message: {
          message_id: prompt.messageId,
          from: { id: Number(actor.botId), is_bot: true },
        },
        voice: {
          file_id: "local-voice-" + id,
          file_unique_id: "unique-voice-" + id,
          duration: 4,
          file_size: voiceBytes.length,
          mime_type: "audio/ogg",
        },
      },
    };
  }
  async function answer(correct = true) {
    heard = correct ? null : "A completely different sentence";
    const update = voiceUpdate(),
      response = await webhook(update);
    await bot.tick();
    return { response, update };
  }
  return {
    ...f,
    bot,
    botOptions,
    study,
    trial,
    speech,
    files,
    catalog,
    linked,
    views,
    outbox,
    sent,
    reservations,
    providerReceipts,
    webhook,
    command,
    choose,
    answer,
    voiceUpdate,
    message,
    speechCalls: () => speechCalls,
    linkedCalls: () => linkedCalls,
    sendCalls: () => sendCalls,
    fail: (value: typeof failure, code = "speech_unavailable") => {
      failure = value;
      speechCode = code;
    },
    recoverReady: (value: boolean) => {
      recoverReady = value;
    },
    admission: (value: boolean) => {
      admissionAvailable = value;
    },
    deliveryMode: (value: typeof sendMode) => {
      sendMode = value;
    },
    offersAvailable: (value: boolean) => {
      offersAvailable = value;
    },
  };
}
