import { telegramCheck } from "../packages/telegram/contracts.ts";

export type TelegramAlarmStorage = Pick<
  DurableObjectStorage,
  "transaction" | "getAlarm" | "setAlarm"
>;

/** Native alarm transactions preserve the earliest deadline across concurrent
 * wakes. A caller must forward the DO's actual alarm event to the factory. */
export function telegramAlarmScheduler(storage: TelegramAlarmStorage) {
  telegramCheck(
    typeof storage.transaction === "function" &&
      typeof storage.getAlarm === "function" &&
      typeof storage.setAlarm === "function",
    "telegram_durable_alarm_required",
    503,
  );
  return async (atMs: number) => {
    telegramCheck(
      Number.isSafeInteger(atMs) && atMs >= 0,
      "telegram_alarm_invalid",
    );
    await storage.transaction(async (transaction) => {
      const previous = await transaction.getAlarm();
      if (previous === null || previous > atMs)
        await transaction.setAlarm(atMs);
    });
  };
}
