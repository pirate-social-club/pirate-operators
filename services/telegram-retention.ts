import {
  TELEGRAM_HISTORY_MS,
  TELEGRAM_OPEN_MS,
  actorKey,
  telegramCheck,
} from "../packages/telegram/contracts.ts";
import type { TelegramTrialRecord } from "../packages/telegram/study-contracts.ts";
import type { TelegramStudyWork } from "../packages/telegram/work.ts";
import type { TelegramTrialLessons } from "./telegram-trial.ts";
import type { TelegramOutbound } from "./telegram-outbox.ts";
import { hasTelegramReservationIntent } from "./telegram-speech.ts";
import { readTelegramSpeechJob } from "./telegram-job-privacy.ts";
import {
  refundUnsentTrialDebit,
  trialDebitKey,
} from "./telegram-trial-quota.ts";
import {
  telegramCopyRetention,
  TELEGRAM_VOICE_HANDLE_MS,
} from "./telegram-copy-retention.ts";

export { TELEGRAM_VOICE_HANDLE_MS } from "./telegram-copy-retention.ts";
/** No raw audio bytes are persisted. File handles expire after application or
 * 24h; status recovery retains frozen context/digests. Open lessons close at
 * 30d. History is eligible completion/closure +30d, subject to recovery holds.
 * This cannot erase messages retained by Telegram itself. */
export function telegramTrialRetention(
  trial: TelegramTrialLessons,
  communityId: string,
  limit = 50,
) {
  telegramCheck(
    Number.isSafeInteger(limit) && limit > 0 && limit <= 100,
    "telegram_retention_limit_invalid",
  );
  const grants = trial.grants,
    store = grants.store,
    now = grants.now();
  const cursorKey = `retention-cursor:${communityId}`,
    cursor = store.get<string>(cursorKey);
  const rows = store.entries<TelegramTrialRecord>("trial:", limit, cursor);
  let erased = 0,
    recoveryHeld = 0,
    handlesErased = 0;
  for (const row of rows) {
    if (
      row.value.historyDeletedAt !== null ||
      row.value.actor.communityId !== communityId
    )
      continue;
    const record = trial.reconcile(row.value),
      jobPrefix = `lesson-job:${actorKey(record.actor)}:${record.id}:`;
    const indexedJobs = store.entries<string>(jobPrefix, 10_000);
    if (indexedJobs.length === 10_000) {
      recoveryHeld++;
      continue;
    }
    const jobs = indexedJobs.flatMap((index) => {
      const value = readTelegramSpeechJob<TelegramStudyWork>(
        store,
        `speech-job:${index.value}`,
      );
      return value ? [{ key: `speech-job:${index.value}`, value }] : [];
    });
    for (const job of jobs)
      if (
        job.value.voice &&
        (job.value.state === "applied" ||
          now >= job.value.acceptedAt + TELEGRAM_VOICE_HANDLE_MS)
      ) {
        const undispatched =
          ["queued", "retry_wait"].includes(job.value.state) ||
          (["dispatching", "uncertain"].includes(job.value.state) &&
            job.value.submissionStarted === false);
        const release = undispatched && hasTelegramReservationIntent(job.value);
        store.transaction(() => {
          if (undispatched) refundUnsentTrialDebit(store, job.value);
          const current = store.get<TelegramTrialRecord>(row.key)!;
          if (
            undispatched &&
            current.state.status === "active" &&
            current.state.currentAttemptId === job.value.id
          ) {
            store.set(row.key, {
              ...current,
              state: { ...current.state, currentAttemptId: null },
            });
          }
          store.set(job.key, {
            ...job.value,
            voice: null,
            ...(undispatched
              ? {
                  state: release ? "releasing" : "cancelled",
                  releaseTo: "cancelled",
                  failure: "telegram_recording_expired",
                }
              : {}),
          });
          if (release) store.set(`job-ready:${job.value.id}`, job.value.id);
        });
        handlesErased++;
      }
    if (
      record.state.completedAt === null ||
      now <= record.state.completedAt + TELEGRAM_HISTORY_MS
    )
      continue;
    const pending = jobs.some(
      (job) =>
        !["applied", "cancelled"].includes(
          store.get<TelegramStudyWork>(job.key)!.state,
        ),
    );
    const indexedDeliveries = store.entries<string>(
      `lesson-delivery:${actorKey(record.actor)}:${record.id}:`,
      10_000,
    );
    if (indexedDeliveries.length === 10_000) {
      recoveryHeld++;
      continue;
    }
    const deliveries = indexedDeliveries.flatMap((index) => {
      const value = store.get<TelegramOutbound>(index.value);
      return value ? [{ key: index.value, value }] : [];
    });
    if (
      pending ||
      deliveries.some((item) =>
        ["sending", "unknown"].includes(item.value.state),
      )
    ) {
      recoveryHeld++;
      continue;
    }
    store.transaction(() => {
      store.set(row.key, {
        id: record.id,
        historyDeletedAt: now,
        actorHash: actorKey(record.actor),
        communityId,
      });
      store.delete(`session:${actorKey(record.actor)}:${record.id}`);
      store.delete(`lesson-pending:${actorKey(record.actor)}:${record.id}`);
      if (store.get(`active-session:${actorKey(record.actor)}`) === record.id)
        store.delete(`active-session:${actorKey(record.actor)}`);
      for (const job of jobs) {
        store.set(`job-tombstone:${job.value.id}`, {
          id: job.value.id,
          lessonId: record.id,
          voiceFingerprint: job.value.voiceFingerprint,
          audioDigest: job.value.audioDigest,
          state: job.value.state,
          reservation: job.value.reservation ?? null,
          resolution: job.value.resolution ?? null,
        });
        store.delete(job.key);
        store.delete(trialDebitKey(job.value.id));
        store.delete(`job-ready:${job.value.id}`);
      }
      for (const index of indexedJobs) store.delete(index.key);
      for (const delivery of deliveries)
        store.set(delivery.key, {
          ...delivery.value,
          payload: { kind: "text", text: "Private history expired." },
          state:
            delivery.value.state === "pending"
              ? "cancelled"
              : delivery.value.state,
        });
      for (const index of indexedDeliveries) store.delete(index.key);
      erased++;
    });
  }
  if (rows.length === limit) store.set(cursorKey, rows.at(-1)!.key);
  else store.delete(cursorKey);
  const copies = telegramCopyRetention(grants, communityId, limit);
  return {
    scanned: rows.length,
    erased: erased + copies.linkedErased,
    recoveryHeld,
    handlesErased: handlesErased + copies.handlesErased,
    exportsScrubbed: copies.exportsScrubbed,
    linkedJobsErased: copies.jobsErased,
    openMs: TELEGRAM_OPEN_MS,
    completedHistoryMs: TELEGRAM_HISTORY_MS,
  };
}
