import {
  actorKey,
  sameActor,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import type { TelegramSpeechJob } from "./telegram-speech.ts";
import type { TelegramJournal } from "./telegram-store.ts";

export type TelegramTrialDebit = {
  actor: ChatActor;
  lessonId: string;
  day: number;
};
export const trialQuotaKey = (actor: ChatActor, day: number) =>
  `trial-quota:${actorKey(actor)}:${day}`;
export const trialDebitKey = (jobId: string) => `trial-quota-debit:${jobId}`;

/** Call in the same transaction as the associated job/lesson transition. */
export function refundTrialDebit(
  store: TelegramJournal,
  job: TelegramSpeechJob,
) {
  const key = trialDebitKey(job.id),
    debit = store.get<TelegramTrialDebit>(key);
  if (
    !debit ||
    debit.lessonId !== job.lessonId ||
    !sameActor(debit.actor, job.actor)
  )
    return;
  const bucket = trialQuotaKey(debit.actor, debit.day);
  const used = store.get<number>(bucket) ?? 0;
  if (used > 0) store.set(bucket, used - 1);
  store.delete(key);
}

export function refundUnsentTrialDebit(
  store: TelegramJournal,
  job: TelegramSpeechJob,
) {
  if (
    job.retry === 0 &&
    job.submissionStarted !== true &&
    (job.state === "queued" ||
      (["dispatching", "uncertain"].includes(job.state) &&
        job.submissionStarted === false))
  )
    refundTrialDebit(store, job);
}
