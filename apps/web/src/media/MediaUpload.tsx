// Capture/review presentation is independently adopted from the centralized
// pure Solid surfaces; transport and submission authority remain community-owned.
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type {
  MediaCapability,
  MediaPurpose,
} from "../../../../packages/community-media/contracts.ts";
import type { MediaClient, MediaStatus, ReadyMedia } from "./client.ts";
import { mediaErrorText } from "./client.ts";
import { DanceRecordingReviewSurface } from "./dance-review-surface.tsx";
import { danceSubmitLabel, mediaReviewVisible } from "./view-state.ts";
import {
  OriginalVideoCaptureSurface,
  OriginalVideoReviewSurface,
  type OriginalVideoCaptureSurfaceProps,
} from "./reference-capture.tsx";
import {
  ActionFooterShell,
  Button,
  MobilePageHeader,
  Spinner,
} from "./reference-ui.ts";

export interface MediaUploadProps {
  client: MediaClient;
  purpose: MediaPurpose;
  selection: {
    songKey: string;
    songRevision: number;
    startSample: number;
    durationSamples: number;
    title: string;
  };
  capability: MediaCapability;
  initialMediaId?: string;
  /** Dance owns camera/audio capture and its frozen segment. No second recorder. */
  capture?: Pick<
    OriginalVideoCaptureSurfaceProps,
    | "status"
    | "elapsedLabel"
    | "recordDisabled"
    | "recordActionLabel"
    | "onFlipCamera"
  > & {
    preview: JSX.Element;
    onRecordToggle: () => void;
    onRetake: () => void;
  };
  /** Exact finished recording from the admitted capture controller. */
  recording?: File;
  onReady?: (media: ReadyMedia) => void;
  /** Actual trusted Dance submission; uploading/ready does not start review. */
  onSubmit?: (media: ReadyMedia) => Promise<void>;
  onWithdrawn?: () => void;
  onClose: () => void;
}
export function MediaUpload(props: MediaUploadProps) {
  const privateTake = () => props.purpose === "private-review";
  const [file, setFile] = createSignal<File | null>(null, { ownedWrite: true }),
    [preview, setPreview] = createSignal<string | undefined>(undefined, {
      ownedWrite: true,
    });
  const [status, setStatus] = createSignal<MediaStatus | null>(null, {
      ownedWrite: true,
    }),
    [busy, setBusy] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true }),
    [submitted, setSubmitted] = createSignal(false),
    [submissionUncertain, setSubmissionUncertain] = createSignal(false);
  let input: HTMLInputElement | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | undefined;
  let disposed = false,
    announced = "",
    requestId = crypto.randomUUID();
  function choose(chosen: File) {
    const old = preview();
    if (old) URL.revokeObjectURL(old);
    setFile(chosen);
    setPreview(URL.createObjectURL(chosen));
    requestId = crypto.randomUUID();
    setError("");
  }
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
    } catch {
      if (!disposed) setError("We couldn’t confirm your recording’s status.");
    }
  }
  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (value) {
      if (!disposed)
        setError(
          value instanceof Error
            ? value.message
            : "Your request could not be confirmed. Resume it without making a new submission.",
        );
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  async function upload() {
    const chosen = file();
    if (!chosen) return;
    if (!props.capability.allowed)
      throw Error(
        privateTake()
          ? "Recording isn’t available for this dance right now."
          : "Public posting is unavailable in this community.",
      );
    if (chosen.size > 32 * 1024 * 1024)
      throw Error(mediaErrorText("media_too_large"));
    const recordingSha256 = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await chosen.arrayBuffer()),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const prior = status();
    const reserved =
      prior?.state === "uploading"
        ? prior
        : await props.client.reserve({
            requestId,
            ...props.selection,
            recordingSha256,
            bytes: chosen.size,
            purpose: props.purpose,
            // Clicking the reference Post action is explicit public-release consent.
            publicConsent: props.purpose === "public-feed",
          });
    setStatus(reserved);
    controller = new AbortController();
    update(await props.client.upload(reserved.id, chosen, controller.signal));
  }
  async function retake() {
    clearTimeout(timer);
    controller?.abort();
    if (
      status() &&
      !["withdrawn", "revoked", "expired"].includes(status()!.state)
    ) {
      update(await props.client.withdraw(status()!.id));
      props.onWithdrawn?.();
    }
    const url = preview();
    if (url) URL.revokeObjectURL(url);
    setPreview(undefined);
    setFile(null);
    setStatus(null);
    setSubmitted(false);
    setSubmissionUncertain(false);
    announced = "";
    requestId = crypto.randomUUID();
    props.capture?.onRetake?.();
  }
  createEffect(
    () => props.initialMediaId,
    (id) => {
      if (id) void refresh(id);
    },
  );
  createEffect(
    () => props.recording,
    (recording) => {
      if (recording && !status()) {
        choose(recording);
        void run(upload);
      }
    },
  );
  onCleanup(() => {
    disposed = true;
    clearTimeout(timer);
    controller?.abort();
    const url = preview();
    if (url) URL.revokeObjectURL(url);
  });
  const preparing = () =>
    ["receiving", "queued", "processing"].includes(status()?.state ?? "") ||
    busy();
  const ended = () =>
    ["expired", "withdrawn", "revoked"].includes(status()?.state ?? "");
  const accepted = () => submitted() || !!status()?.ready?.submissionId;
  const video = (): JSX.Element => (
    <video
      class={
        privateTake()
          ? "mx-auto min-h-0 w-full flex-1 bg-black object-contain"
          : "absolute inset-0 h-full w-full object-contain"
      }
      src={status()?.playbackUrl ?? preview()}
      controls
      playsinline
      preload="metadata"
      aria-label={
        privateTake() ? "Your private recording" : "Your local recording"
      }
    />
  );
  const readyToReview = () =>
    mediaReviewVisible(props.purpose, status()?.state, !!file(), accepted());
  const submitPrivate = () =>
    void run(async () => {
      const ready = status()?.ready;
      if (!ready || !props.onSubmit) return;
      try {
        // The Dance adapter owns one durable command for this exact media;
        // re-entry reconciles/resumes it instead of generating a new submission.
        await props.onSubmit(ready);
        setSubmitted(true);
        setSubmissionUncertain(false);
      } catch (error) {
        setSubmissionUncertain(true);
        throw error;
      }
    });
  return (
    <>
      <input
        ref={input}
        hidden
        type="file"
        accept="video/mp4,video/quicktime,video/webm"
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0];
          if (selected) choose(selected);
        }}
      />
      <Show
        when={readyToReview()}
        fallback={
          <Show
            when={!status() && !busy() && !error()}
            fallback={
              <ActionFooterShell
                fullViewport
                header={
                  <MobilePageHeader
                    title={
                      privateTake()
                        ? accepted()
                          ? "Your recording"
                          : "Dance"
                        : "New video"
                    }
                    onBackClick={props.onClose}
                  />
                }
                bodyClass="flex flex-col gap-4 px-4 pt-[calc(4rem+env(safe-area-inset-top))]"
                footer={
                  <div class="mx-auto grid w-full max-w-md gap-3">
                    <Show when={status()?.state === "uploading" && !busy()}>
                      <Show
                        when={file()}
                        fallback={
                          <p>The original recording isn’t on this device.</p>
                        }
                      >
                        <Button onClick={() => void run(upload)}>
                          Resume upload
                        </Button>
                      </Show>
                    </Show>
                    <Show when={status()?.canRetry}>
                      <Button
                        disabled={busy()}
                        onClick={() =>
                          void run(async () =>
                            update(await props.client.retry(status()!.id)),
                          )
                        }
                      >
                        Try again
                      </Button>
                    </Show>
                    <Show when={error() && status()}>
                      <Button
                        variant="secondary"
                        disabled={busy()}
                        onClick={() => void refresh(status()!.id)}
                      >
                        Check again
                      </Button>
                    </Show>
                    <Show when={ended()}>
                      <Button onClick={() => void run(retake)}>
                        Record again
                      </Button>
                    </Show>
                    <Show
                      when={
                        accepted() ||
                        (status()?.state === "ready" && !privateTake())
                      }
                    >
                      <Show when={props.onClose}>
                        <Button variant="secondary" onClick={props.onClose}>
                          Done
                        </Button>
                      </Show>
                    </Show>
                  </div>
                }
              >
                <Show when={preview()}>
                  <Show
                    when={privateTake()}
                    fallback={
                      <div class="relative mx-auto aspect-[9/16] w-[min(100%,32.625dvh)] overflow-hidden rounded-[var(--radius-2xl)] bg-black">
                        {video()}
                      </div>
                    }
                  >
                    {video()}
                  </Show>
                </Show>
                <Show when={preparing()}>
                  <p role="status">
                    {status()?.state === "uploading"
                      ? "Uploading your recording…"
                      : "Your recording is being prepared."}
                  </p>
                  <Spinner label="Preparing recording" />
                </Show>
                <Show when={status()?.state === "failed"}>
                  <p role="alert">
                    {mediaErrorText(
                      status()?.error ?? "media_processing_failed",
                    )}
                  </p>
                </Show>
                <Show when={error()}>
                  <p role="alert">{error()}</p>
                </Show>
                <Show when={accepted()}>
                  <p role="status">
                    Your submission is waiting for confirmation.
                  </p>
                </Show>
                <Show when={ended()}>
                  <p>This recording session has finished.</p>
                </Show>
                <Show when={status()?.state === "ready" && !privateTake()}>
                  <p role="status">Video posted.</p>
                </Show>
              </ActionFooterShell>
            }
          >
            <Show
              when={!privateTake()}
              fallback={
                <Show
                  when={props.capture}
                  fallback={
                    <p role="status">
                      Recording isn’t available for this dance right now.
                    </p>
                  }
                >
                  <OriginalVideoCaptureSurface
                    {...props.capture}
                    recordDisabled={
                      !props.capability.allowed || props.capture?.recordDisabled
                    }
                    notice={
                      <Show when={!props.capability.allowed}>
                        <p role="status">
                          Recording isn’t available for this dance right now.
                        </p>
                      </Show>
                    }
                    title="Dance"
                    allowUpload={false}
                    onClose={props.onClose}
                    songLabel={props.selection.title}
                    durationLabel={`${props.selection.durationSamples / 48000} s`}
                  />
                </Show>
              }
            >
              <OriginalVideoCaptureSurface
                channel="upload"
                songLabel={props.selection.title}
                onClose={props.onClose}
                uploadDisabled={!props.capability.allowed}
                onUpload={() => input?.click()}
                notice={
                  <Show when={!props.capability.allowed}>
                    <p role="status">
                      Public posting is unavailable in this community.
                    </p>
                  </Show>
                }
              />
            </Show>
          </Show>
        }
      >
        <Show
          when={privateTake()}
          fallback={
            <OriginalVideoReviewSurface
              preview={video()}
              songLabel={props.selection.title}
              submitting={busy()}
              publishDisabled={!props.capability.allowed}
              notice={
                error() ||
                (!props.capability.allowed
                  ? "Public posting is unavailable in this community."
                  : undefined)
              }
              onBack={() => void run(retake)}
              onPublish={() => void run(upload)}
            />
          }
        >
          <DanceRecordingReviewSurface
            preview={video()}
            busy={busy()}
            canSubmit={props.capability.allowed}
            submitLabel={danceSubmitLabel(submissionUncertain())}
            error={
              error() ||
              (!props.capability.allowed
                ? "Recording isn’t available for this dance right now."
                : undefined)
            }
            onBack={props.onClose}
            onSubmit={props.onSubmit ? submitPrivate : undefined}
          />
        </Show>
      </Show>
    </>
  );
}
