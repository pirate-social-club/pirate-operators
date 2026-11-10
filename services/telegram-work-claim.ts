import { randomToken } from "../packages/telegram/security.ts";
import type { TelegramSpeechJob } from "./telegram-speech.ts";
import type { TelegramJournal } from "./telegram-store.ts";

/** A durable token fences paused workers. submissionStarted is written in the
 * SAME synchronous turn immediately before crossing the paid service boundary.
 * Missing legacy evidence is unknown, never a proof that a call was unsent. */
export function telegramWorkClaim<T extends TelegramSpeechJob>(
  store: TelegramJournal,
  id: string,
) {
  const key = `speech-job:${id}`;
  const read = () => store.get<T>(key);
  return {
    owns(token: string | undefined) {
      const current = read();
      return (
        current?.dispatchToken === token && current?.state === "dispatching"
      );
    },
    resetUnsent(snapshot: T) {
      return store.transaction(() => {
        const current = read();
        if (
          !current ||
          current.dispatchToken !== snapshot.dispatchToken ||
          !["dispatching", "uncertain"].includes(current.state) ||
          current.submissionStarted === true
        )
          return current;
        const next = {
          ...current,
          state: "queued" as const,
          dispatchToken: randomToken(),
          submissionStarted: false,
        };
        store.set(key, next);
        return next;
      });
    },
    claim(snapshot: T) {
      return store.transaction(() => {
        const current = read();
        if (
          !current ||
          current.dispatchToken !== snapshot.dispatchToken ||
          !["queued", "retry_wait"].includes(current.state)
        )
          return null;
        const next = {
          ...current,
          audioDigest: snapshot.audioDigest,
          state: "dispatching" as const,
          dispatchToken: randomToken(),
          submissionStarted: false,
        };
        store.set(key, next);
        return next;
      });
    },
    beginSubmission(token: string) {
      return store.transaction(() => {
        const current = read();
        if (
          !current ||
          current.state !== "dispatching" ||
          current.dispatchToken !== token ||
          current.submissionStarted !== false
        )
          return false;
        store.set(key, { ...current, submissionStarted: true });
        return true;
      });
    },
    save(snapshot: T, change: Partial<T>) {
      return store.transaction(() => {
        const current = read();
        if (
          !current ||
          current.dispatchToken !== snapshot.dispatchToken ||
          ["applied", "cancelled", "assessed", "refused"].includes(
            current.state,
          )
        )
          return current;
        const next = { ...current, ...change };
        store.set(key, next);
        return next;
      });
    },
  };
}
