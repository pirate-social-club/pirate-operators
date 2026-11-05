// Browser-local media and immutable retry intent. Authentication stays in the
// host-only HttpOnly cookie and is never copied into this database.
export interface SongDraft {
  authorId: string;
  idempotencyKey: string;
  title: string;
  language: string;
  lyrics: string;
  file: File;
  audioSha256: string;
  acceptedPolicy: string;
  submissionId?: string;
  jobId?: string;
}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("pirate-song-drafts", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("drafts", { keyPath: "authorId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error(
          "Your browser could not save this draft. Enable browser storage and retry.",
        ),
      );
  });
}
export async function readDraft(authorId: string): Promise<SongDraft | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction("drafts", "readonly")
        .objectStore("drafts")
        .get(authorId);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export async function saveDraft(draft: SongDraft) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put(draft);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(
          new Error(
            "The draft could not be saved. Free browser storage and retry.",
          ),
        );
    });
  } finally {
    db.close();
  }
}
export async function audioHash(file: File) {
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return (
    "0x" +
    Array.from(new Uint8Array(hash), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}
