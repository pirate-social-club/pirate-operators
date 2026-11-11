import {
  decodeDanceRecordingMetadata,
  decodeStoredDanceRecording,
  type DanceRecordingStorage,
} from "./dance-recording.ts";

/** Private account-scoped blobs. add(), never put(), protects the original even
 * if a caller fails to acquire its cooperative Web Lock. No URLs or credentials. */
export function createBrowserDanceRecordingStorage(
  accountId: string,
): DanceRecordingStorage {
  if (!accountId.trim()) throw new Error("dance_recording_account_required");
  const name = `pirate-dance-recordings-v1:${encodeURIComponent(accountId)}`;
  const connect = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("dance_recording_storage_unavailable"));
        return;
      }
      const request = indexedDB.open(name, 1);
      let abandoned = false;
      request.onupgradeneeded = () =>
        request.result.createObjectStore("recordings");
      request.onblocked = () => {
        abandoned = true;
        reject(new Error("dance_recording_storage_blocked"));
      };
      request.onerror = () =>
        reject(
          request.error ?? new Error("dance_recording_storage_unavailable"),
        );
      request.onsuccess = () => {
        if (abandoned) request.result.close();
        else resolve(request.result);
      };
    });
  async function transact<T>(
    mode: IDBTransactionMode,
    guard: () => void,
    operation: (store: IDBObjectStore, done: (value: T) => void) => void,
  ): Promise<T> {
    guard();
    const database = await connect();
    try {
      guard();
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction("recordings", mode, {
          durability: "strict",
        });
        let result: T, failure: unknown;
        const fail = (error: unknown) => {
          failure = error;
          transaction.abort();
        };
        transaction.onabort = () =>
          reject(
            failure ??
              transaction.error ??
              new Error("dance_recording_storage_failed"),
          );
        transaction.onerror = () => {
          /* Abort owns rejection; a request success is not a commit. */
        };
        transaction.oncomplete = () => {
          try {
            guard();
            resolve(result);
          } catch (error) {
            reject(error);
          }
        };
        try {
          operation(transaction.objectStore("recordings"), (value) => {
            try {
              guard();
              result = value;
            } catch (error) {
              fail(error);
            }
          });
        } catch (error) {
          fail(error);
        }
      });
    } finally {
      database.close();
    }
  }
  return {
    async exclusive<T>(sessionId: string, use: () => Promise<T>): Promise<T> {
      if (typeof navigator === "undefined" || !navigator.locks)
        throw new Error("dance_recording_lock_unavailable");
      return navigator.locks.request(
        `${name}:${sessionId}`,
        { mode: "exclusive", ifAvailable: true },
        (lock) => {
          if (!lock) throw new Error("dance_recording_busy");
          return use();
        },
      );
    },
    load(sessionId, guard) {
      return transact("readonly", guard, (store, done) => {
        const request = store.get(sessionId);
        request.onsuccess = () => {
          // Decoding is outside the IDB callback so exceptions reject normally.
          done(request.result);
        };
      }).then((value) => {
        guard();
        if (value === undefined) return null;
        const record = decodeStoredDanceRecording(value, accountId);
        if (
          decodeDanceRecordingMetadata(record.metadataJson, accountId)
            .sessionId !== sessionId
        )
          throw new Error("dance_recording_corrupt");
        return record;
      });
    },
    async add(record, guard) {
      record = decodeStoredDanceRecording(record, accountId);
      const sessionId = decodeDanceRecordingMetadata(
        record.metadataJson,
        accountId,
      ).sessionId;
      await transact("readwrite", guard, (store, done) => {
        const request = store.add(record, sessionId);
        request.onsuccess = () => done(undefined);
      });
    },
    async remove(sessionId, guard) {
      await transact("readwrite", guard, (store, done) => {
        const request = store.delete(sessionId);
        request.onsuccess = () => done(undefined);
      });
    },
    async pruneExpired(nowMs, guard) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new Error("dance_recording_clock_unavailable");
      await transact("readwrite", guard, (store, done) => {
        const request = store.openCursor();
        request.onsuccess = () => {
          try {
            guard();
            const cursor = request.result;
            if (!cursor) {
              done(undefined);
              return;
            }
            const record = decodeStoredDanceRecording(cursor.value, accountId);
            const metadata = decodeDanceRecordingMetadata(
              record.metadataJson,
              accountId,
            );
            if (metadata.sessionId !== cursor.key)
              throw new Error("dance_recording_corrupt");
            if (nowMs >= metadata.expiresAtMs) cursor.delete();
            cursor.continue();
          } catch {
            store.transaction.abort();
          }
        };
      });
    },
  };
}
