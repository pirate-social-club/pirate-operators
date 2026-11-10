import { sha256 as sha256Hex } from "viem";
import {
  telegramCheck,
  telegramId,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import {
  TelegramDeliveryError,
  type TelegramDeliveryPort,
  type TelegramNativeMessage,
} from "../packages/telegram/messages.ts";
import type {
  TelegramPublicAudio,
  TelegramVoiceInput,
} from "../packages/telegram/study-contracts.ts";
import { httpsOrigin, readJson } from "../packages/telegram/security.ts";
import type { TelegramVoiceFiles } from "./telegram-speech.ts";
import { MAX_STUDY_AUDIO_BYTES } from "../packages/study/contracts.ts";

async function bytes(response: Response, max: number) {
  telegramCheck(
    response.ok &&
      response.body &&
      Number(response.headers.get("content-length") ?? 0) <= max,
    "telegram_audio_unavailable",
    503,
  );
  const chunks: Uint8Array[] = [],
    reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      telegramCheck(size <= max, "telegram_audio_too_large", 413);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
/** Explicit transport only. Managed bot tokens are runtime inputs and never
 * returned, logged or placed in messages. Local tests supply a simulation. */
export function telegramApi(
  config: { botId: string; botToken: string; communityOrigin: string },
  transport: typeof fetch,
): TelegramDeliveryPort & TelegramVoiceFiles {
  telegramId(config.botId);
  telegramCheck(
    config.botToken.startsWith(config.botId + ":") &&
      config.botToken.length >= config.botId.length + 22,
    "telegram_bot_token_invalid",
  );
  const mediaOrigin = httpsOrigin(config.communityOrigin),
    base = `https://api.telegram.org/bot${config.botToken}/`;
  async function call<T>(
    method: string,
    payload: Record<string, unknown> | FormData,
  ): Promise<T> {
    try {
      const response = await transport(base + method, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        ...(payload instanceof FormData
          ? { body: payload }
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            }),
      });
      const json = (await readJson(response, 32_768)) as {
        ok?: boolean;
        result?: T;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      if (!response.ok || !json.ok) {
        const status = json.error_code ?? response.status;
        throw new TelegramDeliveryError(
          status === 403
            ? "telegram_bot_blocked"
            : status === 429
              ? "telegram_rate_limited"
              : "telegram_delivery_unavailable",
          [400, 401, 403, 404, 413, 429].includes(status)
            ? "known_failed"
            : "unknown",
          Math.max(
            1000,
            Math.min(3600_000, (json.parameters?.retry_after ?? 1) * 1000),
          ),
          status === 403,
        );
      }
      telegramCheck(
        json.result !== undefined,
        "telegram_response_invalid",
        503,
      );
      return json.result;
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      throw new TelegramDeliveryError("telegram_delivery_uncertain", "unknown");
    }
  }
  function actor(who: ChatActor) {
    telegramCheck(who.botId === config.botId, "telegram_wrong_bot", 403);
    return who.chatId;
  }
  async function publicBytes(audio: TelegramPublicAudio) {
    const url = new URL(audio.url);
    telegramCheck(
      url.origin === mediaOrigin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (/^\/api\/public\/posts\/0x[0-9a-f]{64}\/audio$/.test(url.pathname) ||
          /^\/api\/public\/study-reference\/0x[0-9a-f]{64}\/0x[0-9a-f]{64}$/.test(
            url.pathname,
          )) &&
        /^0x[0-9a-f]{64}$/.test(audio.sha256) &&
        Number.isSafeInteger(audio.byteLength) &&
        audio.byteLength > 0 &&
        audio.byteLength <= 50 * 1024 * 1024 &&
        /^[^/\\\x00-\x1f]{1,160}$/.test(audio.filename),
      "telegram_public_audio_invalid",
    );
    const data = await bytes(
      await transport(url.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      }),
      audio.byteLength,
    );
    telegramCheck(
      data.length === audio.byteLength && sha256Hex(data) === audio.sha256,
      "telegram_public_audio_changed",
      503,
    );
    return data;
  }
  return {
    async send(
      who: ChatActor,
      message: TelegramNativeMessage,
      targetMessageId?: number,
    ) {
      const chat_id = actor(who);
      if (message.kind === "start-required")
        message = { kind: "text", text: "Send /start to reconnect this chat." };
      let result: { message_id: number };
      if (message.kind === "pin") {
        telegramCheck(targetMessageId, "telegram_pin_target_pending", 409);
        await call("pinChatMessage", {
          chat_id,
          message_id: targetMessageId,
          disable_notification: true,
        });
        return { messageId: targetMessageId };
      }
      if (message.kind === "text") {
        telegramCheck(
          message.text.length > 0 && message.text.length <= 4096,
          "telegram_message_invalid",
        );
        const reply_markup = message.forceReply
          ? { force_reply: true, selective: true }
          : message.buttons
            ? {
                inline_keyboard: message.buttons.map((row) =>
                  row.map((button) => {
                    telegramCheck(
                      !!button.url !== !!button.data &&
                        button.text.length <= 120,
                      "telegram_button_invalid",
                    );
                    if (button.url)
                      telegramCheck(
                        new URL(button.url).origin === mediaOrigin,
                        "telegram_button_origin_invalid",
                      );
                    if (button.data)
                      telegramCheck(
                        new TextEncoder().encode(button.data).length <= 64,
                        "telegram_button_invalid",
                      );
                    return {
                      text: button.text,
                      ...(button.url
                        ? { url: button.url }
                        : { callback_data: button.data }),
                    };
                  }),
                ),
              }
            : undefined;
        result = await call(
          message.editMessageId ? "editMessageText" : "sendMessage",
          {
            chat_id,
            text: message.text,
            ...(message.editMessageId
              ? { message_id: message.editMessageId }
              : {}),
            ...(reply_markup ? { reply_markup } : {}),
            link_preview_options: { is_disabled: true },
          },
        );
      } else {
        const form = new FormData();
        form.set("chat_id", chat_id);
        if (message.kind === "document") {
          telegramCheck(
            new TextEncoder().encode(message.content).length <= 1024 * 1024 &&
              /^[A-Za-z0-9_.-]{1,120}$/.test(message.filename),
            "telegram_document_invalid",
          );
          form.set(
            "document",
            new Blob([message.content], { type: "application/json" }),
            message.filename,
          );
          result = await call("sendDocument", form);
        } else {
          let data: Uint8Array;
          try {
            data = await publicBytes(message.audio);
          } catch {
            throw new TelegramDeliveryError(
              "telegram_public_audio_unavailable",
              "known_failed",
            );
          }
          const voice = message.kind === "voice";
          form.set(
            voice ? "voice" : "audio",
            new Blob([new Uint8Array(data)], {
              type: voice ? "audio/ogg" : "audio/mpeg",
            }),
            message.audio.filename,
          );
          if (message.kind === "song") form.set("title", message.title);
          result = await call(voice ? "sendVoice" : "sendAudio", form);
        }
      }
      telegramCheck(
        Number.isSafeInteger(result.message_id) && result.message_id > 0,
        "telegram_response_invalid",
        503,
      );
      return { messageId: result.message_id };
    },
    async read(who, voice: TelegramVoiceInput) {
      actor(who);
      telegramCheck(
        voice.reportedBytes <= MAX_STUDY_AUDIO_BYTES &&
          voice.durationMs >= 1000 &&
          voice.durationMs <= 60_000 &&
          voice.contentType === "audio/ogg",
        "telegram_voice_invalid",
      );
      const file = await call<{
        file_path?: string;
        file_size?: number;
        file_unique_id?: string;
      }>("getFile", { file_id: voice.fileId });
      telegramCheck(
        file.file_path &&
          /^[A-Za-z0-9_./-]{1,300}$/.test(file.file_path) &&
          !file.file_path.includes("..") &&
          !file.file_path.startsWith("/") &&
          (file.file_size === undefined ||
            file.file_size <= MAX_STUDY_AUDIO_BYTES) &&
          (file.file_unique_id === undefined ||
            file.file_unique_id === voice.fileUniqueId),
        "telegram_voice_invalid",
      );
      const audio = await bytes(
        await transport(
          `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`,
          { redirect: "manual", signal: AbortSignal.timeout(10_000) },
        ),
        MAX_STUDY_AUDIO_BYTES,
      );
      return new Request("https://telegram-audio.invalid/answer", {
        method: "PUT",
        headers: {
          "content-type": "audio/ogg",
          "x-study-duration-ms": String(voice.durationMs),
        },
        body: new Uint8Array(audio),
      });
    },
  };
}
