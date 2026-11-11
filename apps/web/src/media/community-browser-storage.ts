import type { MediaAttempt, MediaAttemptStorage } from "./media-attempt.ts";

export interface ScopedRecord {
  accountId: string;
  communityId: string;
}
export interface ScopedStorage<T> {
  exclusive<R>(work: () => Promise<R>): Promise<R>;
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  remove(): Promise<void>;
}
export interface BrowserStoragePlatform {
  indexedDB: IDBFactory;
  locks: Pick<LockManager, "request">;
}
export function browserStoragePlatform(): BrowserStoragePlatform {
  if (
    !globalThis.indexedDB ||
    !globalThis.navigator?.locks?.request ||
    typeof File !== "function"
  )
    throw new Error(
      "This browser needs IndexedDB File storage and Web Locks to recover releases safely.",
    );
  return { indexedDB: globalThis.indexedDB, locks: globalThis.navigator.locks };
}
const DATABASE = "pirate-community-composer-v1";
interface Cell<T> {
  revision: number;
  value: T | null;
}
/** Web Locks serializes complete scoped operations across tabs; IDB revision
 * CAS also rejects stale writers. Tombstones prevent remove/recreate ABA. */
export function createScopedBrowserStorage<T extends ScopedRecord>(options: {
  accountId: string;
  communityId: string;
  kind: "song" | "media";
  validate(value: T): void;
  signal?: AbortSignal;
  platform?: BrowserStoragePlatform;
}): ScopedStorage<T> {
  const platform = options.platform ?? browserStoragePlatform();
  if (!platform.indexedDB || !platform.locks?.request)
    throw new Error("Safe browser storage is unavailable.");
  const key = JSON.stringify([
      options.communityId,
      options.accountId,
      options.kind,
    ]),
    lockName = DATABASE + key;
  let held = false,
    revision: number | null = null;
  const validate = (value: T) => {
    if (
      value.accountId !== options.accountId ||
      value.communityId !== options.communityId ||
      "csrf" in value ||
      "session" in value
    )
      throw new Error("Saved release changed private account or community.");
    options.validate(value);
  };
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = platform.indexedDB.open(DATABASE, 1);
      let settled = false;
      request.onupgradeneeded = () =>
        request.result.createObjectStore("records");
      request.onblocked = () => {
        settled = true;
        reject(new Error("Browser storage is blocked by another version."));
      };
      request.onerror = () => {
        settled = true;
        reject(request.error);
      };
      request.onsuccess = () => {
        if (settled) request.result.close();
        else {
          settled = true;
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        }
      };
    });
  const read = async () => {
    if (!held) throw new Error("Storage requires its scoped exclusive lock.");
    const db = await open();
    try {
      return await new Promise<T | null>((resolve, reject) => {
        const tx = db.transaction("records", "readonly"),
          request = tx.objectStore("records").get(key);
        let cell: Cell<T> | undefined;
        request.onsuccess = () => {
          cell = request.result;
        };
        tx.onabort = tx.onerror = () =>
          reject(tx.error ?? new Error("Saved release read failed."));
        tx.oncomplete = () => {
          try {
            revision = cell?.revision ?? 0;
            if (!Number.isSafeInteger(revision) || revision < 0)
              throw new Error("Invalid browser storage revision.");
            if (cell?.value) validate(cell.value);
            resolve(cell?.value ?? null);
          } catch (error) {
            reject(error);
          }
        };
      });
    } finally {
      db.close();
    }
  };
  const write = async (value: T | null) => {
    if (!held || revision === null)
      throw new Error("Load the scoped revision before changing a release.");
    if (value) validate(value);
    const expected = revision,
      next = expected + 1;
    if (!Number.isSafeInteger(next))
      throw new Error("Browser storage revision exhausted.");
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("records", "readwrite", {
            durability: "strict",
          }),
          store = tx.objectStore("records"),
          request = store.get(key);
        let conflict = false;
        request.onsuccess = () => {
          if ((request.result?.revision ?? 0) !== expected) {
            conflict = true;
            tx.abort();
            return;
          }
          store.put({ revision: next, value } satisfies Cell<T>, key);
        };
        tx.oncomplete = () => {
          revision = next;
          resolve();
        };
        tx.onabort = tx.onerror = () =>
          reject(
            new Error(
              conflict
                ? "Saved release changed in another context."
                : "Release could not be saved.",
            ),
          );
      });
    } finally {
      db.close();
    }
  };
  return {
    exclusive: (work) =>
      platform.locks.request(
        lockName,
        {
          mode: "exclusive",
          ...(options.signal ? { signal: options.signal } : {}),
        },
        async () => {
          if (held) throw new Error("Reentrant browser release operation.");
          held = true;
          revision = null;
          try {
            return await work();
          } finally {
            held = false;
            revision = null;
          }
        },
      ),
    load: read,
    save: (value) => write(value),
    remove: () => write(null),
  };
}
export function createBrowserMediaStorage(
  options: Omit<
    Parameters<typeof createScopedBrowserStorage<MediaAttempt>>[0],
    "kind" | "validate"
  >,
): MediaAttemptStorage {
  return createScopedBrowserStorage<MediaAttempt>({
    ...options,
    kind: "media",
    validate: (value) => {
      if (
        value.version !== "pirate.media-attempt/1" ||
        !(value.file instanceof File) ||
        value.file.size !== value.intent.bytes
      )
        throw new Error("Saved video File or version is unavailable.");
    },
  });
}
