import type { Hex } from "viem";

export interface PublicationGrantAttempt {
  requestId: string;
  commandId?: Hex;
  signature?: Hex;
  terminal?: "recorded" | "refused" | "expired";
}

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("pirate-publication-grants", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("attempts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Complete the transaction before returning permission for the next effect. */
export async function publicationGrantAttempt(key: string, next?: PublicationGrantAttempt) {
  const db = await database();
  try {
    return await new Promise<PublicationGrantAttempt | undefined>((resolve, reject) => {
      const tx = db.transaction("attempts", next ? "readwrite" : "readonly");
      const store = tx.objectStore("attempts");
      const request = next ? store.put(next, key) : store.get(key);
      tx.oncomplete = () => resolve(next ?? request.result);
      tx.onabort = () => reject(tx.error ?? Error("Publication request storage was interrupted."));
    });
  } finally {
    db.close();
  }
}
