import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type {
  MediaCapability,
  MediaPurpose,
} from "../../../../packages/community-media/contracts.ts";
import type { MediaClient, MediaStatus, ReadyMedia } from "./client.ts";
import { mediaErrorText } from "./client.ts";
import styles from "./media.module.css";

export interface MediaUploadProps {
  client: MediaClient;
  purpose: MediaPurpose;
  /** Server-frozen reference selection from the song/Dance flow. */
  selection: {
    songKey: string;
    songRevision: number;
    startSample: number;
    durationSamples: number;
    title: string;
  };
  capability: MediaCapability;
  initialMediaId?: string;
  onReady?: (media: ReadyMedia) => void;
  onWithdrawn?: () => void;
}
export function MediaUpload(props: MediaUploadProps) {
  const [file, setFile] = createSignal<File | null>(null),
    [consent, setConsent] = createSignal(false);
  const [status, setStatus] = createSignal<MediaStatus | null>(null),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  let timer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | undefined,
    disposed = false,
    announced = "";
  let requestId = crypto.randomUUID();
  function update(value: MediaStatus) {
    if (disposed) return;
    setStatus(value);
    if (value.ready && announced !== value.id) {
      announced = value.id;
      props.onReady?.(value.ready);
    }
    if (["queued", "processing", "receiving"].includes(value.state))
      timer = setTimeout(() => void refresh(value.id), 2000);
  }
  async function refresh(id: string) {
    clearTimeout(timer);
    try {
      update(await props.client.status(id));
      setError("");
    } catch (error) {
      if (!disposed)
        setError(
          error instanceof Error
            ? error.message
            : "Video status is unavailable. Check again to resume.",
        );
    }
  }
  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (!disposed)
        setError(
          error instanceof Error
            ? error.message
            : "The upload could not be completed.",
        );
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  async function upload() {
    const chosen = file();
    if (!chosen || !props.capability.allowed) return;
    if (chosen.size > 32 * 1024 * 1024)
      throw Error(mediaErrorText("media_too_large"));
    const recordingSha256 = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await chosen.arrayBuffer()),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const previous = status();
    if (
      previous &&
      ["withdrawn", "revoked", "expired"].includes(previous.state)
    ) {
      requestId = crypto.randomUUID();
      setStatus(null);
    }
    const reserved =
      previous?.state === "uploading"
        ? previous
        : await props.client.reserve({
            requestId,
            ...props.selection,
            recordingSha256,
            bytes: chosen.size,
            purpose: props.purpose,
            publicConsent: props.purpose === "public-feed" && consent(),
          });
    setStatus(reserved);
    controller = new AbortController();
    update(await props.client.upload(reserved.id, chosen, controller.signal));
  }
  createEffect(
    () => props.initialMediaId,
    (id) => {
      if (id) void refresh(id);
    },
  );
  onCleanup(() => {
    disposed = true;
    clearTimeout(timer);
    controller?.abort();
  });
  const pending = () =>
    ["queued", "processing", "receiving"].includes(status()?.state ?? "");
  const active = () =>
    status() && !["withdrawn", "revoked", "expired"].includes(status()!.state);
  return (
    <section
      class={styles.composer}
      aria-label={
        props.purpose === "private-review"
          ? "Private Dance recording"
          : "Post a song video"
      }
    >
      <h2>
        {props.purpose === "private-review"
          ? "Private Dance recording"
          : "Post a song video"}
      </h2>
      <p>
        {props.selection.title} · {props.selection.durationSamples / 48000}{" "}
        seconds
      </p>
      <p>
        {props.purpose === "private-review"
          ? "Only you and authorized community reviewers can play this recording. Dance review does not publish it."
          : "This clip will be playable by anyone while the community permits it."}
      </p>
      <Show when={!props.capability.allowed}>
        <p role="status">
          {props.capability.reason === "owner_decision_pending"
            ? "Public posting awaits the community owner's policy."
            : "Video upload is unavailable for this account."}
        </p>
      </Show>
      <label>
        Recording (MP4, MOV or WebM, up to 32 MiB)
        <input
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          disabled={
            busy() ||
            (!!active() && status()?.state !== "uploading") ||
            !props.capability.allowed
          }
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0] ?? null);
            requestId = crypto.randomUUID();
            setError("");
          }}
        />
      </label>
      <Show when={props.purpose === "public-feed"}>
        <label>
          <input
            type="checkbox"
            checked={consent()}
            disabled={busy() || !!active() || !props.capability.allowed}
            onChange={(event) => setConsent(event.currentTarget.checked)}
          />
          I have permission to publish this clip publicly.
        </label>
      </Show>
      <Show when={!active() || status()?.state === "uploading"}>
        <button
          type="button"
          disabled={
            busy() ||
            !file() ||
            !props.capability.allowed ||
            (props.purpose === "public-feed" && !consent())
          }
          onClick={() => void run(upload)}
        >
          {busy() ? "Uploading…" : "Upload recording"}
        </button>
      </Show>
      <Show when={pending()}>
        <p role="status">
          {status()?.state === "processing"
            ? "Processing your video…"
            : "Your video is saved and waiting for processing."}
        </p>
      </Show>
      <Show when={busy() && status()?.state === "uploading"}>
        <button
          type="button"
          onClick={() => {
            controller?.abort();
            void props.client
              .withdraw(status()!.id)
              .then(update)
              .catch(() =>
                setError(
                  "Cancellation could not be confirmed. Check video status and withdraw again.",
                ),
              );
          }}
        >
          Cancel upload
        </button>
      </Show>
      <Show when={status()?.state === "failed"}>
        <p role="alert">
          {mediaErrorText(status()?.error ?? "media_processing_failed")}
        </p>
        <Show when={status()?.canRetry}>
          <button
            type="button"
            disabled={busy()}
            onClick={() =>
              void run(async () =>
                update(await props.client.retry(status()!.id)),
              )
            }
          >
            Retry processing
          </button>
        </Show>
      </Show>
      <Show when={status()?.state === "ready"}>
        <p role="status">
          Video ready
          {props.purpose === "private-review"
            ? " for private review"
            : " for public playback"}
          .
        </p>
        <video
          class={styles.video}
          controls
          playsinline
          preload="metadata"
          src={status()?.playbackUrl}
          aria-label="Your processed recording"
        />
      </Show>
      <Show
        when={
          status() &&
          ["expired", "withdrawn", "revoked"].includes(status()!.state)
        }
      >
        <p role="status">
          This recording is {status()?.state}. Choose a recording to start
          again.
        </p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
        <Show when={status()}>
          <button
            type="button"
            disabled={busy()}
            onClick={() => void refresh(status()!.id)}
          >
            Check video status
          </button>
        </Show>
      </Show>
      <Show when={active()}>
        <button
          type="button"
          disabled={busy()}
          onClick={() =>
            void run(async () => {
              clearTimeout(timer);
              update(await props.client.withdraw(status()!.id));
              props.onWithdrawn?.();
            })
          }
        >
          Withdraw and erase recording
        </button>
      </Show>
    </section>
  );
}
