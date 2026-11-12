import { privateHeaders } from "../packages/telegram/security.ts";
import type { TelegramBot } from "./telegram-bot.ts";
import { TelegramManagedPublication } from "./telegram-managed-publication.ts";
import { telegramCheck } from "../packages/telegram/contracts.ts";

/** The coordinator supplies a durable earliest-deadline alarm/queue. An in-memory
 * timer or waitUntil alone does not meet this contract. No paid work runs in ACK. */
export function telegramRuntime(
  bot: TelegramBot,
  scheduleWork: (atMs: number) => Promise<void>,
  now: () => number,
  publication?: TelegramManagedPublication,
) {
  const ready = async () => {
    const grants = bot.views.linking.grants;
    telegramCheck(
      !grants.store.get(`bot-publication-managed:${bot.scope.communityId}`) ||
        (publication instanceof TelegramManagedPublication &&
          publication.grants === grants),
      "telegram_managed_publication_required",
      503,
    );
    await publication?.ready();
  };
  const pending = () => {
    const store = bot.views.linking.grants.store;
    return (
      publication?.pending() ||
      ["update-ready:", "job-ready:", "outbox-ready:"].some(
        (prefix) => store.entries(prefix, 1).length > 0,
      )
    );
  };
  return {
    async wake() {
      if (pending()) await scheduleWork(now());
    },
    async webhook(request: Request) {
      try {
        await ready();
      } catch {
        return Response.json(
          { error: "telegram_publication_pending" },
          { status: 503, headers: privateHeaders() },
        );
      }
      const response = await bot.webhook(request);
      if (!response.ok) return response;
      try {
        if (pending()) await scheduleWork(now());
        return response;
      } catch {
        // Receipt stays durable; Telegram retries the same update and schedules
        // it again. It cannot create a second attempt or provider request.
        return Response.json(
          { error: "telegram_wake_unavailable" },
          { status: 503, headers: privateHeaders() },
        );
      }
    },
    async tick() {
      // Arm recovery before doing external work, including after an alarm was
      // consumed. The scheduler must preserve an earlier existing deadline.
      if (pending()) await scheduleWork(now() + 15_000);
      try {
        // ready() always recovers invalidations before checking ordinary work.
        await ready();
        return await bot.tick();
      } finally {
        if (pending()) await scheduleWork(now() + 1000);
      }
    },
  };
}
