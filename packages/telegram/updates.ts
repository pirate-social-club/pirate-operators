import {
  telegramCheck,
  telegramId,
  type BotScope,
  type ChatActor,
} from "./contracts.ts";
import type { TelegramVoiceInput } from "./study-contracts.ts";

export type TelegramUpdate = {
  id: number;
  actor: ChatActor;
  messageId: number;
} & (
  | {
      kind: "command";
      command:
        | "start"
        | "songs"
        | "resume"
        | "download"
        | "rewards"
        | "connect"
        | "settings"
        | "history"
        | "website"
        | "stop"
        | "help";
    }
  | { kind: "callback"; token: string; queryId: string }
  | { kind: "voice"; voice: TelegramVoiceInput; replyMessageId: number }
  | { kind: "invalid_voice" }
);
const integer = (value: unknown, min = 1) => {
  telegramCheck(
    typeof value === "number" && Number.isSafeInteger(value) && value >= min,
    "telegram_update_invalid",
  );
  return value;
};
const object = (value: unknown): Record<string, any> => {
  telegramCheck(
    value && typeof value === "object" && !Array.isArray(value),
    "telegram_update_invalid",
  );
  return value as Record<string, any>;
};
/** Selective behavior reference: api legacy 67f58050 webhook-parsing.ts.
 * Independently implemented private-chat-only subset; no username fallback,
 * forwarded audio, group assistant or retained free-form conversation. */
export function parseTelegramUpdate(
  value: unknown,
  scope: BotScope,
): TelegramUpdate {
  const root = object(value),
    id = integer(root.update_id, 0);
  telegramCheck(
    !!root.message !== !!root.callback_query,
    "telegram_update_unsupported",
  );
  const callback = root.callback_query ? object(root.callback_query) : null;
  const message = object(callback ? callback.message : root.message),
    sender = object(callback ? callback.from : message.from);
  const chat = object(message.chat),
    userId = telegramId(sender.id),
    chatId = telegramId(chat.id);
  telegramCheck(
    chat.type === "private" && userId === chatId && sender.is_bot !== true,
    "telegram_private_chat_required",
    403,
  );
  telegramCheck(
    !message.forward_origin &&
      !message.forward_date &&
      !message.sender_chat &&
      !message.via_bot,
    "telegram_forwarded_message_refused",
    403,
  );
  const actor: ChatActor = { ...scope, userId, chatId },
    messageId = integer(message.message_id);
  if (callback) {
    telegramCheck(
      message.from?.is_bot === true &&
        telegramId(message.from.id) === scope.botId,
      "telegram_callback_wrong_bot",
      403,
    );
    telegramCheck(
      typeof callback.data === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(callback.data) &&
        typeof callback.id === "string" &&
        callback.id.length <= 128,
      "telegram_callback_invalid",
    );
    return {
      id,
      actor,
      messageId,
      kind: "callback",
      token: callback.data,
      queryId: callback.id,
    };
  }
  if (message.voice) {
    const voice = object(message.voice),
      reply = message.reply_to_message;
    if (
      !reply ||
      reply.from?.is_bot !== true ||
      telegramId(reply.from.id) !== scope.botId ||
      !Number.isSafeInteger(voice.duration) ||
      voice.duration < 1 ||
      voice.duration > 60 ||
      (voice.file_size !== undefined &&
        (!Number.isSafeInteger(voice.file_size) ||
          voice.file_size < 1 ||
          voice.file_size > 524288))
    )
      return { id, actor, messageId, kind: "invalid_voice" };
    telegramCheck(
      typeof voice.file_id === "string" &&
        voice.file_id.length > 0 &&
        voice.file_id.length <= 512 &&
        typeof voice.file_unique_id === "string" &&
        voice.file_unique_id.length > 0 &&
        voice.file_unique_id.length <= 256 &&
        (voice.mime_type === undefined || voice.mime_type === "audio/ogg"),
      "telegram_voice_invalid",
    );
    return {
      id,
      actor,
      messageId,
      kind: "voice",
      replyMessageId: integer(reply.message_id),
      voice: {
        fileId: voice.file_id,
        fileUniqueId: voice.file_unique_id,
        contentType: "audio/ogg",
        durationMs: voice.duration * 1000,
        reportedBytes: voice.file_size ?? 524288,
      },
    };
  }
  const match =
    typeof message.text === "string"
      ? /^\/(start|songs|resume|download|rewards|connect|settings|history|website|stop)(?:\s*)$/.exec(
          message.text.trim(),
        )
      : null;
  return {
    id,
    actor,
    messageId,
    kind: "command",
    command: match
      ? (match[1] as Extract<TelegramUpdate, { kind: "command" }>["command"])
      : "help",
  };
}
