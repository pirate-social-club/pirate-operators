// Native browser cases. Coordinator must bundle/run with its browser harness;
// this is intentionally not a Node test that pretends IndexedDB/Web Locks exist.
import {
  browserStoragePlatform,
  createScopedBrowserStorage,
} from "../src/media/community-browser-storage.ts";
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
interface Value {
  accountId: string;
  communityId: string;
  file: File;
  blob: Blob;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const dbOpen = (factory: IDBFactory) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open("pirate-community-composer-v1", 1);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
export async function runCommunityStorageBrowserCases(peerModuleUrl: string) {
  const platform = browserStoragePlatform(),
    accountId = crypto.randomUUID(),
    communityId = "browser-fixture-" + crypto.randomUUID();
  const options = {
    platform,
    accountId,
    communityId,
    kind: "song" as const,
    validate: (value: Value) => {
      check(
        value.file instanceof File && value.blob instanceof Blob,
        "structured-cloned File/Blob lost",
      );
    },
  };
  const a = createScopedBrowserStorage<Value>(options),
    b = createScopedBrowserStorage<Value>(options);
  const value: Value = {
    accountId,
    communityId,
    file: new File([new Uint8Array([1, 4, 9])], "recording.mp3", {
      type: "audio/mpeg",
      lastModified: 12345,
    }),
    blob: new Blob(["fixture bytes"]),
  };
  const key = JSON.stringify([communityId, accountId, "song"]),
    lockName = "pirate-community-composer-v1" + key;
  await a.exclusive(async () => {
    check((await a.load()) === null, "fresh scope not empty");
    await a.save(value);
  });
  await b.exclusive(async () => {
    const saved = await b.load();
    check(
      saved?.file.name === value.file.name &&
        saved.file.lastModified === 12345 &&
        saved.file.type === "audio/mpeg",
      "File metadata changed",
    );
    check(
      Array.from(new Uint8Array(await saved.file.arrayBuffer())).join() ===
        "1,4,9",
      "File bytes changed",
    );
    check((await saved.blob.text()) === "fixture bytes", "Blob bytes changed");
  });
  const entered = deferred(),
    release = deferred();
  let secondEntered = false;
  const first = a.exclusive(async () => {
    await a.load();
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const second = b.exclusive(async () => {
    secondEntered = true;
    await b.load();
  });
  const waiting = await navigator.locks.query();
  check(
    waiting.held?.some(
      (lock) => lock.name === lockName && lock.mode === "exclusive",
    ),
    "scoped exclusive lock absent",
  );
  check(!secondEntered, "second context bypassed held lock");
  release.resolve();
  await first;
  await second;
  check(secondEntered, "second owner never acquired lock");
  const peer = new Worker(peerModuleUrl, { type: "module" });
  const messages: string[] = [],
    waiters = new Map<
      string,
      { resolve(): void; reject(error: Error): void }
    >();
  let peerFailure: Error | undefined;
  const fail = (message: string) => {
    peerFailure = new Error(message);
    for (const waiter of waiters.values()) waiter.reject(peerFailure);
    waiters.clear();
  };
  peer.onmessage = (event) => {
    if (event.data.type === "error") {
      fail(event.data.message);
      return;
    }
    messages.push(event.data.type);
    waiters.get(event.data.type)?.resolve();
    waiters.delete(event.data.type);
  };
  peer.onerror = (event) => {
    event.preventDefault();
    fail(event.message);
  };
  const wait = (kind: string) =>
    peerFailure
      ? Promise.reject(peerFailure)
      : messages.includes(kind)
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              waiters.delete(kind);
              reject(new Error("Peer timed out: " + kind));
            }, 5000);
            waiters.set(kind, {
              resolve() {
                clearTimeout(timer);
                resolve();
              },
              reject(error) {
                clearTimeout(timer);
                reject(error);
              },
            });
          });
  const peerRelease = deferred(),
    peerHeld = deferred();
  const holder = a.exclusive(async () => {
    await a.load();
    peerHeld.resolve();
    await peerRelease.promise;
  });
  await peerHeld.promise;
  try {
    peer.postMessage({ accountId, communityId });
    await wait("requested");
    let snapshot = await navigator.locks.query();
    const deadline = performance.now() + 5000;
    while (
      !snapshot.pending?.some((lock) => lock.name === lockName) &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshot = await navigator.locks.query();
    }
    check(
      snapshot.pending?.some((lock) => lock.name === lockName),
      "separate worker did not wait on the same scoped lock",
    );
    check(!messages.includes("entered"), "separate worker bypassed exclusion");
    peerRelease.resolve();
    await holder;
    await wait("finished");
  } finally {
    peerRelease.resolve();
    await holder;
    peer.terminate();
  }
  await a.exclusive(async () => {
    await a.load();
    const db = await dbOpen(platform.indexedDB);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite", {
          durability: "strict",
        }),
        s = tx.objectStore("records"),
        r = s.get(key);
      r.onsuccess = () =>
        s.put({ ...r.result, revision: r.result.revision + 1 }, key);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
    let rejected = false;
    try {
      await a.save(value);
    } catch {
      rejected = true;
    }
    check(rejected, "stale CAS writer succeeded despite bypassing Web Lock");
  });
  await a.exclusive(async () => {
    await a.load();
    await a.remove();
  });
  const db = await dbOpen(platform.indexedDB);
  const tombstone = await new Promise<{ revision: number; value: null }>(
    (resolve, reject) => {
      const r = db
        .transaction("records", "readonly")
        .objectStore("records")
        .get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    },
  );
  db.close();
  check(
    tombstone.value === null && tombstone.revision > 1,
    "remove reset revision or erased tombstone",
  );
  await b.exclusive(async () => {
    check((await b.load()) === null, "tombstone did not read empty");
    await b.save(value);
    let rejected = false;
    try {
      await b.save({ ...value, accountId: crypto.randomUUID() });
    } catch {
      rejected = true;
    }
    check(rejected, "foreign account persisted");
    await b.remove();
  });
  return {
    cases: [
      "actual File/Blob clone",
      "two-instance Web Lock exclusion",
      "separate worker exclusion/File read",
      "IDB CAS rejects bypass writer",
      "tombstone ABA fence",
      "foreign account denial",
    ],
    scope: communityId,
  };
}
