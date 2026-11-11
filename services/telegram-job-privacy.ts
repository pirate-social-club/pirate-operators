import { telegramGrade } from "../packages/telegram/grading.ts";
import type { TelegramSpeechJob } from "./telegram-speech.ts";
import type { TelegramJournal } from "./telegram-store.ts";

/** Legacy grades can be reduced without altering the admission evidence. */
export function readTelegramSpeechJob<T extends TelegramSpeechJob>(
  store: TelegramJournal,
  key: string,
): T | undefined {
  const job = store.get<T>(key);
  if (!job || job.grade === null) return job;
  const grade = telegramGrade(job.grade);
  if (JSON.stringify(grade) === JSON.stringify(job.grade)) return job;
  const scrubbed = { ...job, grade };
  store.set(key, scrubbed);
  return scrubbed;
}
