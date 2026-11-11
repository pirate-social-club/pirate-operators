import { createScopedBrowserStorage } from "../src/media/community-browser-storage.ts";
interface Value {
  accountId: string;
  communityId: string;
  file: File;
  blob: Blob;
}
const worker = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{ accountId: string; communityId: string }>,
  ) => void;
  postMessage(value: unknown): void;
};
worker.onmessage = (event) => {
  const { accountId, communityId } = event.data;
  const store = createScopedBrowserStorage<Value>({
    accountId,
    communityId,
    kind: "song",
    validate: (value) => {
      if (!(value.file instanceof File) || !(value.blob instanceof Blob))
        throw new Error("Peer File/Blob clone failed");
    },
  });
  const work = store.exclusive(async () => {
    const value = await store.load();
    if (
      !value ||
      value.file.name !== "recording.mp3" ||
      (await value.blob.text()) !== "fixture bytes"
    )
      throw new Error("Peer read changed stored File identity");
    worker.postMessage({ type: "entered" });
  });
  worker.postMessage({ type: "requested" });
  void work.then(
    () => worker.postMessage({ type: "finished" }),
    (error) => worker.postMessage({ type: "error", message: String(error) }),
  );
};
