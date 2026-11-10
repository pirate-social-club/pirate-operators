import {
  TELEGRAM_HISTORY_MS,
  TELEGRAM_OPEN_MS,
  actorKey,
} from "../packages/telegram/contracts.ts";
import type { TelegramGrants } from "./telegram-grants.ts";
import type {
  TelegramStudySession,
  TelegramStudyWork,
} from "../packages/telegram/work.ts";
import type { TelegramOutbound } from "./telegram-outbox.ts";
import { telegramScan } from "./telegram-store.ts";
import { digest } from "../packages/protocol/index.ts";

export const TELEGRAM_VOICE_HANDLE_MS = 24 * 3600_000;
/** Bounded persisted cursors cover every page, including orphan/legacy rows.
 * Expired linked copies become digest-only replay/unknown evidence; the existing
 * Study publisher retains ownership of its independent authoritative recovery. */
export function telegramCopyRetention(
  grants: TelegramGrants,
  communityId: string,
  limit: number,
) {
  const store = grants.store,
    now = grants.now();
  let linkedErased = 0,
    handlesErased = 0,
    exportsScrubbed = 0,
    jobsErased = 0;
  for (const row of telegramScan<TelegramStudySession>(
    store,
    "session:",
    limit,
  )) {
    const session = row.value;
    if (session.mode !== "linked" || session.actor.communityId !== communityId)
      continue;
    const bound = session.view.startedAt + TELEGRAM_OPEN_MS;
    if (session.view.status === "active" && now >= bound) {
      session.view = {
        ...session.view,
        status: "abandoned",
        completedAt: bound,
        prompt: null,
      };
      store.set(row.key, session);
    }
    if (
      session.view.completedAt === null ||
      now <= session.view.completedAt + TELEGRAM_HISTORY_MS
    )
      continue;
    store.transaction(() => {
      const key = actorKey(session.actor),
        id = session.view.id;
      store.set(`linked-history-expired:${key}:${id}`, {
        expiredAt: now,
        lessonId: id,
      });
      store.delete(row.key);
      store.delete(`lesson-pending:${key}:${id}`);
      if (store.get(`active-session:${key}`) === id)
        store.delete(`active-session:${key}`);
      linkedErased++;
    });
  }
  for (const row of telegramScan<TelegramStudyWork>(
    store,
    "speech-job:",
    limit,
  )) {
    const job = row.value;
    if (job.mode !== "linked" || job.actor.communityId !== communityId)
      continue;
    const key = actorKey(job.actor),
      session = store.get<TelegramStudySession>(
        `session:${key}:${job.lessonId}`,
      );
    const terminal = session?.view.completedAt ?? job.resultView?.completedAt;
    const expired =
      !!store.get(`linked-history-expired:${key}:${job.lessonId}`) ||
      now >
        (terminal ?? job.acceptedAt + TELEGRAM_OPEN_MS) + TELEGRAM_HISTORY_MS;
    if (expired) {
      store.transaction(() => {
        store.set(`job-tombstone:${job.id}`, {
          id: job.id,
          lessonId: job.lessonId,
          actorHash: key,
          mode: job.mode,
          voiceFingerprint: job.voiceFingerprint,
          audioDigest: job.audioDigest,
          state: job.state,
          submissionStarted: job.submissionStarted ?? null,
          dispatchToken: job.dispatchToken ?? null,
          durationMs: job.durationMs,
          presentation: job.presentation,
          take: job.take,
          lineId: job.line.lineId,
          grantId: job.grant?.id ?? null,
          resultDigest: digest({ grade: job.grade, view: job.resultView }),
          unknown:
            ["dispatching", "uncertain"].includes(job.state) &&
            job.submissionStarted !== false,
          expiredAt: now,
        });
        store.delete(row.key);
        store.delete(`job-ready:${job.id}`);
        store.delete(`lesson-job:${key}:${job.lessonId}:${job.id}`);
        jobsErased++;
      });
    } else if (
      job.voice &&
      (job.state === "applied" ||
        now >= job.acceptedAt + TELEGRAM_VOICE_HANDLE_MS)
    ) {
      const unsent =
        ["queued", "retry_wait"].includes(job.state) ||
        job.submissionStarted === false;
      store.set(row.key, {
        ...job,
        voice: null,
        ...(unsent
          ? { state: "cancelled", failure: "telegram_recording_expired" }
          : {}),
      });
      handlesErased++;
    }
  }
  // This scan also scrubs exports written before lesson guards existed. It does
  // not depend on the trial/session row, or on an arbitrary per-lesson page cap.
  for (const row of telegramScan<TelegramOutbound>(store, "outbox:", limit)) {
    const delivery = row.value;
    if (delivery.actor.communityId !== communityId) continue;
    const expiredExport =
      delivery.payload.kind === "document" && delivery.payload.expiresAt <= now;
    const expiredLinked =
      delivery.sessionId &&
      store.get(
        `linked-history-expired:${actorKey(delivery.actor)}:${delivery.sessionId}`,
      );
    if (!expiredExport && !expiredLinked) continue;
    store.set(row.key, {
      ...delivery,
      payload: { kind: "text", text: "Private history expired." },
      state: delivery.state === "pending" ? "cancelled" : delivery.state,
    });
    if (delivery.sessionId)
      store.delete(
        `lesson-delivery:${actorKey(delivery.actor)}:${delivery.sessionId}:${digest([actorKey(delivery.actor), delivery.effectId])}`,
      );
    exportsScrubbed++;
  }
  return { linkedErased, handlesErased, exportsScrubbed, jobsErased };
}
