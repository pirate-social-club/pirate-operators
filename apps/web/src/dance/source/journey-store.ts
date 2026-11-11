import type { DanceCapture } from "../../../../../packages/dance/contracts.ts";
import type { MediaStatus } from "../../../../../packages/community-media/contracts.ts";
import { danceTargetKey, type DanceScope } from "./ports.ts";

export interface DanceUploadEntry {
  readonly requestId: string;
  readonly recordingSha256: string;
  readonly bytes: number;
  readonly mediaId: string | null;
  readonly put: "not_started" | "unknown" | "acknowledged";
  /** Facts only; no signed URLs, private playback URLs or credentials. */
  readonly status: Omit<MediaStatus, "playbackUrl"> | null;
}
export interface DanceJourneyEntry {
  readonly version: 1;
  readonly revision: number;
  readonly targetKey: string;
  readonly capture: DanceCapture | null;
  readonly upload: DanceUploadEntry | null;
  readonly captureUnknown: boolean;
  readonly submission: "none" | "unknown" | "accepted";
  readonly terminal: null | "canceled" | "expired";
}
export interface DanceJourneyHandle {
  read(): DanceJourneyEntry;
  save(
    patch: Partial<
      Omit<DanceJourneyEntry, "version" | "revision" | "targetKey">
    >,
  ): Promise<DanceJourneyEntry>;
  archive(): Promise<void>;
}
export interface DanceJourneyStore {
  read(scope: DanceScope, guard: () => void): Promise<DanceJourneyEntry>;
  exclusive<T>(
    scope: DanceScope,
    guard: () => void,
    use: (h: DanceJourneyHandle) => Promise<T>,
  ): Promise<T>;
}
export const emptyJourney = (scope: DanceScope): DanceJourneyEntry => ({
  version: 1,
  revision: 0,
  targetKey: danceTargetKey(scope),
  capture: null,
  upload: null,
  captureUnknown: false,
  submission: "none",
  terminal: null,
});
export function decodeJourney(
  v: unknown,
  scope: DanceScope,
): DanceJourneyEntry {
  if (v === undefined) return emptyJourney(scope);
  if (!v || typeof v !== "object") throw Error("dance_journal_corrupt");
  const r = v as DanceJourneyEntry;
  if (
    Object.keys(r).length !== 8 ||
    r.version !== 1 ||
    r.targetKey !== danceTargetKey(scope) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 0 ||
    typeof r.captureUnknown !== "boolean" ||
    !["none", "unknown", "accepted"].includes(r.submission) ||
    ![null, "canceled", "expired"].includes(r.terminal)
  )
    throw Error("dance_journal_corrupt");
  if (
    r.upload &&
    (typeof r.upload.requestId !== "string" ||
      !r.capture ||
      !/^[a-f0-9]{64}$/.test(r.upload.recordingSha256) ||
      !Number.isSafeInteger(r.upload.bytes) ||
      r.upload.bytes <= 0 ||
      !["not_started", "unknown", "acknowledged"].includes(r.upload.put) ||
      (r.upload.mediaId !== null && typeof r.upload.mediaId !== "string") ||
      (r.upload.status &&
        ("playbackUrl" in r.upload.status ||
          r.upload.status.id !== r.upload.mediaId)))
  )
    throw Error("dance_journal_corrupt");
  if (
    (r.submission !== "none" && !r.capture) ||
    (r.submission === "unknown" && !r.upload) ||
    (r.terminal && (r.captureUnknown || r.submission === "unknown"))
  )
    throw Error("dance_journal_corrupt");
  return r;
}
/** Every save waits for actual IndexedDB transaction completion before the
 * caller may send. Web Locks serialize the complete scope across tabs. */
export function createBrowserDanceJourneyStore(
  factory: IDBFactory = globalThis.indexedDB,
): DanceJourneyStore {
  async function transaction<T>(
    key: string,
    guard: () => void,
    change?: {
      before: DanceJourneyEntry;
      after: DanceJourneyEntry;
      archive?: true;
    },
  ): Promise<T> {
    guard();
    if (!factory) throw Error("dance_journal_unavailable");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open("pirate-dance-source-journey-v1", 1);
      let abandoned = false;
      r.onupgradeneeded = () => r.result.createObjectStore("journeys");
      r.onblocked = () => {
        abandoned = true;
        reject(Error("dance_journal_blocked"));
      };
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        if (abandoned) r.result.close();
        else resolve(r.result);
      };
    });
    try {
      guard();
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(
          "journeys",
          change ? "readwrite" : "readonly",
          { durability: "strict" },
        );
        const store = tx.objectStore("journeys"),
          r = store.get(key);
        let value: T, failure: unknown;
        r.onsuccess = () => {
          try {
            guard();
            if (change) {
              if (
                JSON.stringify(r.result ?? null) !==
                JSON.stringify(
                  change.before.revision === 0 ? null : change.before,
                )
              )
                throw Error("dance_journal_conflict");
              store.put(change.after, key);
              if (change.archive) {
                const archiveKey = `${key}:archive:${change.before.capture?.captureId}`;
                const archived = store.get(archiveKey);
                archived.onsuccess = () => {
                  try {
                    guard();
                    if (
                      archived.result !== undefined &&
                      JSON.stringify(archived.result) !==
                        JSON.stringify(change.before)
                    )
                      throw Error("dance_journal_archive_conflict");
                    if (archived.result === undefined)
                      store.add(change.before, archiveKey);
                  } catch (e) {
                    failure = e;
                    tx.abort();
                  }
                };
              }
              value = change.after as T;
            } else value = r.result;
          } catch (e) {
            failure = e;
            tx.abort();
          }
        };
        tx.oncomplete = () => {
          try {
            guard();
            resolve(value);
          } catch (e) {
            reject(e);
          }
        };
        tx.onabort = () =>
          reject(failure ?? tx.error ?? Error("dance_journal_unavailable"));
        tx.onerror = () => {};
      });
    } finally {
      db.close();
    }
  }
  const read = async (scope: DanceScope, guard: () => void) =>
    decodeJourney(await transaction(danceTargetKey(scope), guard), scope);
  return {
    read,
    async exclusive(scope, guard, use) {
      guard();
      if (typeof navigator === "undefined" || !navigator.locks)
        throw Error("dance_recording_lock_unavailable");
      return navigator.locks.request(
        "dance-source:" + danceTargetKey(scope),
        { mode: "exclusive" },
        async () => {
          let value = await read(scope, guard),
            active = true;
          const live = () => {
            guard();
            if (!active) throw Error("dance_journal_handle_closed");
          };
          try {
            return await use({
              read: () => {
                live();
                return structuredClone(value);
              },
              save: async (patch) => {
                live();
                const next = decodeJourney(
                  { ...value, ...patch, revision: value.revision + 1 },
                  scope,
                );
                const saved = await transaction<DanceJourneyEntry>(
                  danceTargetKey(scope),
                  live,
                  { before: value, after: next },
                );
                live();
                value = saved;
                return structuredClone(value);
              },
              archive: async () => {
                live();
                if (
                  !value.capture ||
                  value.captureUnknown ||
                  value.submission === "unknown"
                )
                  throw Error("dance_response_unknown");
                await transaction(danceTargetKey(scope), live, {
                  before: value,
                  after: value,
                  archive: true,
                });
                live();
              },
            });
          } finally {
            active = false;
          }
        },
      );
    },
  };
}
