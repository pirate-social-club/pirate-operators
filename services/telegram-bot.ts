import { digest } from "../packages/protocol/index.ts";
import {
  TelegramError,
  actorKey,
  telegramCheck,
  type BotScope,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import {
  parseTelegramUpdate,
  type TelegramUpdate,
} from "../packages/telegram/updates.ts";
import {
  equalSecret,
  privateHeaders,
  readJson,
} from "../packages/telegram/security.ts";
import type { TelegramNativeMessage } from "../packages/telegram/messages.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";
import type { TelegramBotViews } from "./telegram-bot-view.ts";
import type { TelegramOutbox } from "./telegram-outbox.ts";
import { telegramScan } from "./telegram-store.ts";

interface UpdateReceipt {
  update: TelegramUpdate;
  fingerprint: string;
  state: "queued" | "processing" | "complete";
  retryAt: number;
  createdAt: number;
  preferenceApplied?: {
    key: "reminders" | "rewards" | "dance";
    value: boolean;
  };
}
/** Ordinary native fallback; optional widget rendering is supplied through
 * TelegramPresentationPort after the UI lane's review. */
export class TelegramBot {
  readonly views: TelegramBotViews;
  readonly outbox: TelegramOutbox;
  readonly scope: BotScope;
  readonly webhookSecret: string;
  constructor(options: {
    views: TelegramBotViews;
    outbox: TelegramOutbox;
    scope: BotScope;
    webhookSecret: string;
  }) {
    this.views = options.views;
    this.outbox = options.outbox;
    this.scope = options.scope;
    this.webhookSecret = options.webhookSecret;
    telegramCheck(
      /^[A-Za-z0-9_-]{32,256}$/.test(options.webhookSecret),
      "telegram_webhook_secret_required",
    );
  }
  async webhook(request: Request): Promise<Response> {
    try {
      telegramCheck(request.method === "POST", "method_not_allowed", 405);
      telegramCheck(
        await equalSecret(
          request.headers.get("x-telegram-bot-api-secret-token") ?? "",
          this.webhookSecret,
        ),
        "telegram_webhook_unauthorized",
        403,
      );
      const update = parseTelegramUpdate(await readJson(request), this.scope);
      this.views.linking.grants.current(this.scope);
      const key = `update:${this.scope.communityId}:${this.scope.botId}:${this.scope.generation}:${update.id}`,
        fingerprint = digest(update),
        grants = this.views.linking.grants;
      grants.store.transaction(() => {
        const previous = grants.store.get<UpdateReceipt>(key);
        if (previous) {
          telegramCheck(
            previous.fingerprint === fingerprint,
            "telegram_update_conflict",
            409,
          );
          return;
        }
        const record: UpdateReceipt = {
          update,
          fingerprint,
          state: "queued",
          retryAt: grants.now(),
          createdAt: grants.now(),
        };
        grants.store.set(key, record);
        grants.store.set(`update-ready:${key}`, key);
      });
      return Response.json(
        update.kind === "callback"
          ? { method: "answerCallbackQuery", callback_query_id: update.queryId }
          : { ok: true },
        { headers: privateHeaders() },
      );
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof TelegramError
              ? error.code
              : "telegram_update_invalid",
        },
        {
          status: error instanceof TelegramError ? error.status : 400,
          headers: privateHeaders(),
        },
      );
    }
  }
  private async commands(
    update: TelegramUpdate,
    receiptKey: string,
  ): Promise<TelegramNativeMessage[]> {
    const actor = update.actor,
      grants = this.views.linking.grants,
      study = this.views.study;
    if (update.kind === "command" && update.command === "start")
      grants.start(actor);
    grants.binding(actor);
    if (update.kind === "invalid_voice")
      return [
        {
          kind: "text",
          text: "Reply to the lesson line with a voice message between 1 and 60 seconds.",
        },
      ];
    if (update.kind === "voice") {
      const job = await study.accept(
        actor,
        update.voice,
        update.replyMessageId,
        update.id,
      );
      grants.store.set(`job-ready:${job.id}`, job.id);
      return [];
    }
    if (update.kind === "callback") {
      const applied =
        grants.store.get<UpdateReceipt>(receiptKey)?.preferenceApplied;
      const action = applied
        ? { kind: "preferences" as const, ...applied }
        : this.views.action(actor, update.token, update.messageId);
      if (action.kind === "songs")
        return [await this.views.home(actor, action.page)];
      if (action.kind === "preferences") {
        if (action.key !== "reminders") await grants.assert(actor);
        grants.store.transaction(() => {
          const receipt = grants.store.get<UpdateReceipt>(receiptKey)!;
          if (receipt.preferenceApplied) return;
          telegramCheck(
            grants.store.get<number>(`control:${actorKey(actor)}`) ===
              update.id,
            "telegram_control_stale",
            409,
          );
          const prefs = grants.preferences(actor),
            value = action.value ?? !prefs[action.key];
          grants.setPreferences(actor, { ...prefs, [action.key]: value });
          grants.store.set(receiptKey, {
            ...receipt,
            preferenceApplied: { key: action.key, value },
          });
        });
        return [this.views.settings(actor)];
      }
      const view =
        action.kind === "song"
          ? await study.start(actor, action.key, String(update.id), update.id)
          : await study.resume(actor);
      return this.views.prompt(view);
    }
    const command = update.kind === "command" ? update.command : "help";
    switch (command) {
      case "start":
      case "songs":
        return [await this.views.home(actor)];
      case "resume":
        return this.views.prompt(await study.resume(actor));
      case "download": {
        const { song } = await this.views.selected(actor);
        return [{ kind: "song", audio: song.publicAudio, title: song.title }];
      }
      case "rewards":
        return [await this.views.rewards(actor)];
      case "connect":
        return [
          {
            kind: "text",
            text:
              grants.read(actor)?.revokedAt === null
                ? "Your account is connected."
                : "Connect your account for future lessons.",
            buttons: [[await this.views.accountButton(actor)]],
          },
        ];
      case "settings":
        return [this.views.settings(actor)];
      case "history":
        return [await this.views.history(actor)];
      case "website": {
        const { song } = await this.views.selected(actor);
        return [
          {
            kind: "text",
            text: "Continue on website",
            buttons: [
              [
                {
                  text: "Open song",
                  url: `${this.views.origin}/#song-${song.song.postId}`,
                },
              ],
            ],
          },
        ];
      }
      case "stop":
        grants.setPreferences(actor, {
          reminders: false,
          rewards: false,
          dance: false,
        });
        return [
          {
            kind: "text",
            text: "Notifications paused. Change them in /settings.",
          },
        ];
      default:
        return [
          {
            kind: "text",
            text: "Use /songs to practise, /download to save the current song, or /settings for notifications.",
          },
        ];
    }
  }
  async processUpdate(key: string) {
    const grants = this.views.linking.grants;
    const receipt = grants.store.get<UpdateReceipt>(key);
    if (
      !receipt ||
      receipt.state === "complete" ||
      receipt.retryAt > grants.now()
    )
      return;
    const update = receipt.update,
      control =
        update.kind === "callback" ||
        (update.kind === "command" &&
          ["start", "songs", "resume"].includes(update.command));
    const claimed = grants.store.transaction(() => {
      const current = grants.store.get<UpdateReceipt>(key)!;
      if (current.state === "complete" || current.retryAt > grants.now())
        return false;
      if (control) {
        const controlKey = `control:${actorKey(update.actor)}`,
          last = grants.store.get<number>(controlKey) ?? -1;
        if (last > update.id) {
          grants.store.set(key, { ...current, state: "complete" });
          grants.store.delete(`update-ready:${key}`);
          return false;
        }
        grants.store.set(controlKey, update.id);
      }
      grants.store.set(key, {
        ...current,
        state: "processing",
        retryAt: grants.now() + 30_000,
      });
      return true;
    });
    if (!claimed) return;
    let messages: TelegramNativeMessage[];
    try {
      messages = await this.commands(update, key);
    } catch (error) {
      const code =
        error instanceof TelegramError ? error.code : "telegram_unavailable";
      if (code === "telegram_control_stale") messages = [];
      else if (code === "telegram_unavailable") throw error;
      else if (code === "telegram_start_required")
        messages = [{ kind: "start-required" }];
      else
        messages = [
          {
            kind: "text",
            text:
              code === "telegram_history_expired"
                ? "This lesson's private history has expired. Use /songs to start a new lesson."
                : code === "telegram_reply_to_current_prompt"
                  ? "Reply to the current lesson line to continue."
                  : code === "telegram_choose_song" ||
                      code === "telegram_button_stale"
                    ? "Use /songs to continue."
                    : code === "telegram_answer_pending"
                      ? "Checking your answer. Your progress is saved."
                      : code === "telegram_start_required"
                        ? "Send /start to reconnect this chat."
                        : "Learning is unavailable right now. Your progress is saved.",
          },
        ];
    }
    let grantGuard: { grantId: string; authorityVersion: string } | undefined;
    const remembered = grants.read(update.actor);
    if (
      remembered?.revokedAt === null &&
      !messages.every((message) => message.kind === "start-required")
    ) {
      try {
        const fresh = await grants.assert(update.actor, remembered.id);
        grantGuard = {
          grantId: fresh.id,
          authorityVersion: fresh.authorityVersion,
        };
      } catch {
        messages = [
          {
            kind: "text",
            text: "Your account is unavailable. Open account settings to continue.",
          },
        ];
      }
    }
    grants.store.transaction(() => {
      const current = grants.store.get<UpdateReceipt>(key)!;
      if (current.state === "complete") return;
      if (
        !control ||
        grants.store.get<number>(`control:${actorKey(update.actor)}`) ===
          update.id
      ) {
        const hasPrompt = messages.some(
          (message) =>
            (message.kind === "text" || message.kind === "voice") &&
            message.promptKey,
        );
        const guard = {
          ...grantGuard,
          ...(hasPrompt
            ? { sessionId: this.views.study.session(update.actor).view.id }
            : {}),
        };
        messages.forEach((message, index) => {
          const effect = `${key}:${index}`;
          this.outbox.enqueue(update.actor, effect, message, guard);
          if (message.kind === "text" && message.home && !message.editMessageId)
            this.outbox.enqueue(
              update.actor,
              `${key}:pin`,
              { kind: "pin", targetEffect: effect },
              guard,
            );
        });
      }
      // Keep only the normalized command/attachment facts required for replay;
      // arbitrary text and the original webhook body were never retained.
      grants.store.set(key, {
        ...current,
        state: "complete",
        update:
          update.kind === "voice"
            ? {
                id: update.id,
                actor: update.actor,
                messageId: update.messageId,
                kind: "command",
                command: "help",
              }
            : update,
      });
      grants.store.delete(`update-ready:${key}`);
    });
  }
  async processWork(id: string) {
    const grants = this.views.linking.grants;
    const job = await this.views.study.work(id);
    if (job.state === "cancelled") {
      grants.store.delete(`job-ready:${id}`);
      return;
    }
    if (job.state !== "applied" || job.rendered) return;
    const messages = await this.views.outcome(job);
    grants.store.transaction(() => {
      const current = grants.store.get<TelegramStudyWork>(`speech-job:${id}`)!;
      if (!current || current.rendered) return;
      const guard = {
        sessionId: job.lessonId,
        ...(job.grant
          ? {
              grantId: job.grant.id,
              authorityVersion: job.grant.authorityVersion,
            }
          : {}),
      };
      messages.forEach((message, index) =>
        this.outbox.enqueue(
          job.actor,
          `outcome:${id}:${index}`,
          message,
          guard,
        ),
      );
      grants.store.set(`speech-job:${id}`, { ...current, rendered: true });
      grants.store.delete(`job-ready:${id}`);
    });
  }
  async tick(limit = 20) {
    telegramCheck(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 100,
      "telegram_tick_limit_invalid",
    );
    const grants = this.views.linking.grants,
      actors = new Map<string, ChatActor>();
    for (const item of telegramScan<string>(
      grants.store,
      "update-ready:",
      limit,
    )) {
      const receipt = grants.store.get<UpdateReceipt>(item.value);
      if (receipt)
        actors.set(actorKey(receipt.update.actor), receipt.update.actor);
      await this.processUpdate(item.value).catch(() => undefined);
    }
    for (const item of telegramScan<string>(
      grants.store,
      "job-ready:",
      limit,
    )) {
      const job = grants.store.get<TelegramStudyWork>(
        `speech-job:${item.value}`,
      );
      if (job) actors.set(actorKey(job.actor), job.actor);
      await this.processWork(item.value).catch(() => undefined);
    }
    for (const item of telegramScan<ChatActor>(
      grants.store,
      "outbox-ready:",
      limit,
    ))
      actors.set(actorKey(item.value), item.value);
    for (const actor of actors.values()) await this.outbox.drain(actor);
    return { actors: actors.size };
  }
}
