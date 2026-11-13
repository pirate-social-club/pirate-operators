import { createDancePostingViewport, dancePostingAllowed } from "./dance-viewport.ts";
import { isServer } from "@solidjs/web";
import {
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import type { SnapshotFrom } from "xstate";
import { Button, MobilePageHeader, Spinner } from "../design-system.ts";
import {
  assertCurrent,
  danceScopeKey,
  type DanceSourcePorts,
} from "./ports.ts";
import { privateAccessLost } from "../client.ts";
import { originalHoldCopy } from "./command-ordering.ts";
import { createDanceRecorder } from "./dance-recorder.ts";
import {
  createDanceJourneyActor,
  type DanceJourneyActor,
  type createDanceRecorderMachine,
} from "./dance-recorder-machine.ts";
import { OriginalVideoCaptureSurface } from "./video-original-audio-surface.tsx";
import { VideoCaptureError } from "./platform/capture-failure.ts";
import { DanceFundedObjectives } from "./dance-funded-objectives.tsx";
import { DanceReviewPage } from "./dance-review-page.tsx";

export function DanceRecorderPanel(props: {
  readonly source: DanceSourcePorts;
  readonly songLabel?: string;
  readonly onBack: () => void;
  readonly onAccessLost: () => void;
  readonly onSignIn?: () => void;
  readonly recorder?: typeof createDanceRecorder;
  readonly assertFreshPosting?: () => void;
}) {
  const postingAllowed = createDancePostingViewport();
  const assertFreshPosting = () => {
    props.assertFreshPosting?.();
    if (!dancePostingAllowed()) throw Error("dance_posting_unavailable");
  };
  const options = untrack(() => ({
    ...props,
    scope: { ...props.source.scope },
    termsHash: props.source.consent.termsHash,
    profileLabel: props.source.scope.profileLabel,
  }));
  const [state, setState] = createSignal<SnapshotFrom<
    ReturnType<typeof createDanceRecorderMachine>
  > | null>(null, { ownedWrite: true });
  const [preview, setPreview] = createSignal<string | undefined>(undefined, {
    ownedWrite: true,
  });
  const [denied, setDenied] = createSignal(false);
  let alive = true,
    recorder: ReturnType<typeof createDanceRecorder> | undefined,
    journey: DanceJourneyActor | undefined;
  let localVideo: HTMLVideoElement | undefined;
  let video: HTMLVideoElement | undefined,
    previewTimer: ReturnType<typeof setTimeout> | undefined;
  const clearCamera = () => {
    if (video) {
      video.pause();
      video.srcObject = null;
    }
  };
  const clearPreview = () => {
    if (localVideo) {
      localVideo.pause();
      localVideo.removeAttribute("src");
      localVideo.load();
    }
    clearTimeout(previewTimer);
    const url = preview();
    if (url) URL.revokeObjectURL(url);
    setPreview(undefined);
  };
  const showPreview = (blob: Blob, expiresAtMs: number) => {
    if (
      !alive ||
      denied() ||
      !options.source.currentScope() ||
      danceScopeKey(options.source.currentScope()!) !==
        danceScopeKey(options.scope) ||
      document.visibilityState === "hidden" ||
      expiresAtMs <= Date.now()
    )
      return;
    clearCamera();
    clearPreview();
    setPreview(URL.createObjectURL(blob));
    previewTimer = setTimeout(clearPreview, expiresAtMs - Date.now());
  };
  const visibility = () => {
    if (document.visibilityState === "hidden")
      journey?.send({ type: "BACKGROUND" });
    else journey?.send({ type: "FOREGROUND" });
  };
  const online = () => journey?.send({ type: "FOREGROUND" });
  const back = () => {
    if (state()?.value === "camera" && recorder) {
      void recorder
        .cancelBeforeTake(new AbortController().signal)
        .catch(() => {})
        .finally(() => {
          if (alive) options.onBack();
        });
    } else options.onBack();
  };
  onSettled(() => {
    if (!alive || denied() || !dancePostingAllowed()) return;
    recorder = (options.recorder ?? createDanceRecorder)({
      ...options.source,
      currentScope: () =>
        alive && !denied() ? options.source.currentScope() : null,
      assertFreshPosting,
    });
    journey = createDanceJourneyActor({
      recorder,
      termsHash: options.termsHash,
      preview: showPreview,
      pause: () => {
        recorder?.pause();
        clearCamera();
        clearPreview();
      },
    });
    journey.subscribe((snapshot) => {
      if (alive && !denied()) {
        if (privateAccessLost(snapshot.context.error)) {
          deny();
          return;
        }
        setState(snapshot);
      }
    });
    journey.start();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
  });
  onCleanup(() => {
    alive = false;
    journey?.stop();
    recorder?.dispose();
    clearCamera();
    clearPreview();
    if (!isServer) {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
    }
  });
  const matches = (value: string) => state()?.value === value;
  const view = () => state()?.context.view;
  const camera = () => {
    const value = view();
    return value?.kind === "camera" &&
      (matches("camera") ||
        (matches("capturing") &&
          ["preparing_audio", "recording"].includes(state()!.context.stage)))
      ? value
      : undefined;
  };
  const session = () => {
    const value = view();
    return value?.kind === "camera"
      ? value.ready.session
      : value?.kind === "upload"
        ? value.upload.session
        : value?.session;
  };
  const review = () => (state()?.matches("review") ? session() : undefined);
  const objectives = () => {
    const value = view();
    return matches("objectives") && value?.kind === "objectives"
      ? value.context
      : undefined;
  };
  const processing = () => state()?.matches("processing") ?? false;
  const finished = () => {
    const value = view();
    return (
      value?.kind === "expired" ||
      value?.kind === "terminal" ||
      (value?.kind === "upload" && value.upload.kind === "expired")
    );
  };
  const missingOriginal = () => {
    const value = view();
    return (
      value?.kind === "upload" &&
      ["missing_recording", "original_command_missing", "unavailable"].includes(
        value.upload.kind,
      )
    );
  };
  const errorMessage = () => {
    const value = view();
    if (value?.kind === "upload") {
      if (value.upload.kind === "missing_recording")
        return "The original recording isn’t on this device.";
      if (value.upload.kind === "original_command_missing")
        return "The original upload details aren’t on this device. No new upload has been started.";
      if (value.upload.kind === "unavailable")
        return "This recording is unavailable.";
    }
    const error = state()?.context.error;
    const held = originalHoldCopy(error);
    if (held) return "This recording needs confirmation. Resume to continue.";
    if (error instanceof VideoCaptureError && error.reason === "camera_denied")
      return "Camera or microphone access is off. Allow access in your browser, then retry.";
    if (
      error instanceof VideoCaptureError &&
      error.reason === "capability_unavailable"
    )
      return "This browser can’t record this dance. Try another browser.";
    if (
      error instanceof Error &&
      error.message === "dance_recorder_funded_unavailable"
    )
      return "Recording isn’t available for this dance right now.";
    return "Your recording was interrupted. Resume to continue with the saved recording, if one exists.";
  };
  const status = () => {
    if (state()?.matches({ processing: "interrupted" }))
      return "Connection interrupted. We’ll check when you reconnect or return.";
    if (state()?.matches({ processing: "resting" }))
      return "Your recording is still being prepared. You can leave and return later.";
    if (processing()) return "Your recording is being prepared.";
    if (matches("capturing"))
      return {
        preparing_audio: "Starting…",
        recording: "Recording",
        saving: "Saving your recording…",
        uploading: "Uploading your recording…",
      }[state()!.context.stage];
    if (matches("resuming")) return "Resuming your upload…";
    if (matches("recovery")) return errorMessage();
    if (matches("paused"))
      return "Recording paused while this screen is hidden.";
    return "Preparing your camera and song…";
  };
  function deny() {
    if (denied()) return;
    setDenied(true);
    journey?.send({ type: "ACCESS_LOST" });
    journey?.stop();
    recorder?.dispose();
    clearCamera();
    clearPreview();
    setState(null);
    options.onAccessLost();
  }
  const unsubscribeDenial = options.source.client.onAccessLost?.(() => {
    if (alive) deny();
  });
  onCleanup(() => unsubscribeDenial?.());
  createEffect(
    () => props.source.currentScope(),
    (value) => {
      if (!value || danceScopeKey(value) !== danceScopeKey(options.scope))
        deny();
    },
  );
  return (
    <Show
      when={!denied()}
      fallback={<p role="alert">This recording is not available.</p>}
    >
      <section
        role={review() ? undefined : "main"}
        class="fixed inset-0 z-40 bg-background text-foreground"
        data-dance-recorder={
          processing()
            ? "processing"
            : state()?.matches("review")
              ? "review"
              : (state()?.value.toString() ?? "preparing")
        }
      >
        <Show
          when={review()}
          keyed
          fallback={
            <>
              <Show when={!camera()}>
                <h1 class="sr-only">Dance</h1>
                <MobilePageHeader
                  title="Dance"
                  density="compact"
                  onBackClick={back}
                  backAriaLabel="Back to dance"
                  trailingAction={
                    <span class="max-w-24 truncate text-xs text-muted-foreground">
                      {options.profileLabel}
                    </span>
                  }
                />
              </Show>
              <Show
                when={camera()}
                keyed
                fallback={
                  <div class="flex h-dvh flex-col gap-4 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[calc(4rem+env(safe-area-inset-top))]">
                    <Show when={preview()}>
                      {(url) => (
                        <video
                          ref={(element) => {
                            localVideo = element;
                            onCleanup(() => {
                              element.pause();
                              element.removeAttribute("src");
                              element.load();
                            });
                          }}
                          class="min-h-0 flex-1 bg-black object-contain"
                          src={url()}
                          controls
                          playsinline
                          aria-label="Your local recording"
                        />
                      )}
                    </Show>
                    <Show
                      when={objectives()}
                      keyed
                      fallback={
                        <>
                          <p role="status" aria-live="polite">
                            {postingAllowed() ? status() : "Recording is available on mobile."}
                          </p>
                          <Show
                            when={
                              processing() &&
                              !state()?.matches({
                                processing: "interrupted",
                              }) &&
                              !state()?.matches({ processing: "resting" })
                            }
                          >
                            <Spinner label="Preparing recording" />
                          </Show>
                          <Show when={matches("recovery")}>
                            <Show
                              when={
                                view()?.kind === "recovery" ||
                                view()?.kind === "upload_recovery"
                              }
                              fallback={
                                <Show
                                  when={finished()}
                                  fallback={
                                    <Show when={!missingOriginal()}>
                                      <Button
                                        disabled={!postingAllowed()}
                                        onClick={() =>
                                          dancePostingAllowed() && journey?.send({ type: "RETRY" })
                                        }
                                      >
                                        Resume recording
                                      </Button>
                                    </Show>
                                  }
                                >
                                  <p>This recording session has finished.</p>
                                  <Button
                                    disabled={!postingAllowed()}
                                    onClick={() =>
                                      dancePostingAllowed() && journey?.send({ type: "NEW_ATTEMPT" })
                                    }
                                  >
                                    Record again
                                  </Button>
                                </Show>
                              }
                            >
                              <p>Your saved recording is ready to upload.</p>
                              <Button
                                onClick={() =>
                                  journey?.send({ type: "RESUME" })
                                }
                              >
                                Resume upload
                              </Button>
                            </Show>
                          </Show>
                          <Show
                            when={state()?.matches({
                              processing: "interrupted",
                            })}
                          >
                            <Button
                              variant="secondary"
                              onClick={() => journey?.send({ type: "RETRY" })}
                            >
                              Retry connection
                            </Button>
                          </Show>
                        </>
                      }
                    >
                      {(context) => (
                        <DanceFundedObjectives
                          context={context}
                          disabled={!postingAllowed()}
                          onAccept={() => { if (dancePostingAllowed()) journey?.send({ type: "ACCEPT" }); }}
                        />
                      )}
                    </Show>
                  </div>
                }
              >
                {(value) => (
                  <OriginalVideoCaptureSurface
                    title="Dance"
                    allowUpload={false}
                    onClose={back}
                    songLabel={options.songLabel}
                    status={
                      matches("capturing") &&
                      state()?.context.stage === "recording"
                        ? "recording"
                        : "idle"
                    }
                    elapsedLabel={
                      matches("capturing")
                        ? `${Math.floor(state()!.context.elapsed / 60000)}:${String(Math.floor(state()!.context.elapsed / 1000) % 60).padStart(2, "0")}`
                        : "0:00"
                    }
                    durationLabel={`${value.ready.session.body_end_ms / 1000} s`}
                    timerElapsedOnly
                    timerClass="rounded-none bg-transparent px-0 py-0 text-base font-semibold leading-6 backdrop-blur-none"
                    recordDisabled={!matches("camera") || !postingAllowed()}
                    recordActionLabel={
                      matches("camera")
                        ? "Record"
                        : state()?.context.stage === "preparing_audio"
                          ? "Starting recording"
                          : "Recording in progress"
                    }
                    onRecordToggle={() => { if (dancePostingAllowed()) journey?.send({ type: "RECORD" }); }}
                    preview={
                      <video
                        ref={(element) => {
                          video = element;
                          element.srcObject = value.stream;
                          void element.play().catch(() => {});
                        }}
                        class="absolute inset-0 h-full w-full object-cover"
                        muted
                        autoplay
                        playsinline
                        aria-label="Camera preview"
                      />
                    }
                  />
                )}
              </Show>
            </>
          }
        >
          {(value) => (
            <DanceReviewPage
              source={options.source}
              assertFreshPosting={assertFreshPosting}
              songLabel={options.songLabel}
              localPreview={preview()}
              journey={journey}
              onBack={options.onBack}
              onAccessLost={deny}
              onSignIn={options.onSignIn}
            />
          )}
        </Show>
      </section>
    </Show>
  );
}
