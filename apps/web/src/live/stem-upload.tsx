import { createSignal, For, onCleanup } from "solid-js";
import { Button } from "../ui.ts";
import { get, post, putAudio } from "./api.ts";
import { audioHash } from "./draft.ts";

export const slots = ["instrumental", "vocals"] as const;
type Slot = (typeof slots)[number];
type Files = Partial<Record<Slot, File>>;
interface Stem {
  slot: Slot;
  state: string;
  sha256: string;
  byteLength: number;
}
const label = (slot: Slot) =>
  slot === "instrumental" ? "Instrumental" : "Vocals";
function validate(file: File) {
  if (
    !file.size ||
    file.size > 25 * 1024 * 1024 ||
    !file.name.toLowerCase().endsWith(".mp3")
  )
    throw new Error("Choose an MP3 of up to 25 MiB for each stem.");
}
export async function uploadStemFiles(id: string, files: Files, csrf: string) {
  for (const slot of slots) {
    const file = files[slot];
    if (!file) continue;
    validate(file);
    await post(
      `/api/uploads/${id}/stems/${slot}`,
      { sha256: await audioHash(file), byteLength: file.size },
      csrf,
    );
    await putAudio(`/api/uploads/${id}/stems/${slot}`, file, csrf);
  }
}
// Separate bounded browser draft for attachments to an already submitted master.
// No authentication, provider receipt or private account identifier is stored.
async function savedFiles(key: string, value?: Files): Promise<Files> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("pirate-song-stems", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("stems");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () =>
      reject(
        new Error(
          "Browser storage is unavailable. Enable it to save the stems.",
        ),
      );
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("stems", value ? "readwrite" : "readonly"),
        store = tx.objectStore("stems");
      const r = value ? store.put(value, key) : store.get(key);
      tx.oncomplete = () => resolve(value ?? r.result ?? {});
      tx.onerror = tx.onabort = () =>
        reject(
          new Error(
            "The stems could not be saved. Free browser storage and retry.",
          ),
        );
    });
  } finally {
    db.close();
  }
}
export function StemUploads(props: {
  submissionId: string;
  authorId: string;
  csrf: string;
}) {
  const [files, setFiles] = createSignal<Files>({}),
    [stems, setStems] = createSignal<Stem[]>([]),
    [busy, setBusy] = createSignal(false),
    [message, setMessage] = createSignal("Loading saved stems…");
  let stopped = false;
  const key = () => `${props.authorId}:${props.submissionId}`;
  const sealed = (slot: Slot) =>
    stems().some((s) => s.slot === slot && s.state === "sealed");
  async function refresh() {
    const result = await get<{ stems: Stem[] }>(
      `/api/uploads/${props.submissionId}/stems`,
    );
    if (!stopped) setStems(result.stems);
  }
  void (async () => {
    try {
      const saved = await savedFiles(key());
      await refresh();
      if (!stopped) {
        setFiles(saved);
        setMessage(
          "Add both MP3 stems. Vocals are used to align your supplied lyrics.",
        );
      }
    } catch {
      if (!stopped)
        setMessage("The saved stems could not be loaded. Reload to retry.");
    }
  })();
  onCleanup(() => {
    stopped = true;
  });
  async function select(slot: Slot, file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      validate(file);
      const next = { ...files(), [slot]: file };
      await savedFiles(key(), next);
      setFiles(next);
      setMessage(
        "Stem saved in this browser. Upload it to attach it to this release.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "The stem could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="live-stems">
      <h4>Instrumental and vocals</h4>
      <For each={slots}>
        {(slot) => (
          <label>
            {label(slot)}
            <input
              type="file"
              aria-label={label(slot)}
              accept="audio/mpeg,.mp3"
              disabled={busy() || sealed(slot)}
              onChange={(e) => void select(slot, e.currentTarget.files?.[0])}
            />
            <span class="live-muted">
              {sealed(slot)
                ? "Uploaded"
                : (files()[slot]?.name ?? "MP3 required")}
            </span>
          </label>
        )}
      </For>
      <Button
        disabled={
          busy() ||
          slots.every(sealed) ||
          slots.some((s) => !sealed(s) && !files()[s])
        }
        onClick={() =>
          void (async () => {
            setBusy(true);
            try {
              setMessage("Uploading saved stems…");
              await uploadStemFiles(
                props.submissionId,
                Object.fromEntries(
                  slots.filter((s) => !sealed(s)).map((s) => [s, files()[s]]),
                ),
                props.csrf,
              );
              await refresh();
              setMessage("Both stems are saved with this release.");
            } catch (e) {
              setMessage(
                e instanceof Error
                  ? e.message
                  : "The upload was interrupted. Retry the saved stems.",
              );
            } finally {
              setBusy(false);
            }
          })()
        }
      >
        Upload stems
      </Button>
      <p role="status" class="live-muted">
        {message()}
      </p>
    </section>
  );
}
