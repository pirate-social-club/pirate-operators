// Independently adapted c7 dance-review-page: original ActionFooterShell,
// explicit submission, retained preview, bounded GET observation and cancel
// dialog. Public visibility/publication is held; canonical receipt truth differs.
import { isServer } from "@solidjs/web";
import {
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import {
  ActionFooterShell,
  Button,
  MobilePageHeader,
  Modal,
  ModalContent,
  ModalHeader,
  ModalTitle,
  Type,
} from "../design-system.ts";
import { privateAccessLost } from "../client.ts";
import { assertRequestedReview, originalHoldCopy } from "./command-ordering.ts";
import {
  createDanceJourneyActor,
  type DanceJourneyActor,
} from "./dance-recorder-machine.ts";
import {
  createDanceReviewController,
  type DanceReviewView,
} from "./dance-review-controller.ts";
import {
  danceResultPresentation,
  danceReviewEditable,
  danceReviewPending,
  type DanceResult,
} from "./dance-review-api.ts";
import {
  assertCurrent,
  danceScopeKey,
  type DanceSourcePorts,
} from "./ports.ts";

export function DanceReviewPage(props: {
  readonly source: DanceSourcePorts;
  readonly reviewId?: string;
  readonly localPreview?: string;
  readonly journey?: DanceJourneyActor;
  readonly onBack: () => void;
  readonly onAccessLost: () => void;
  readonly onSignIn?: () => void;
}) {
  const provided = untrack(() => ({ ...props }));
  const journey =
    provided.journey ??
    createDanceJourneyActor({ initialReview: true }).start();
  const [snapshot, setSnapshot] = createSignal(journey.getSnapshot());
  const subscription = journey.subscribe(setSnapshot);
  const [phase, setPhase] = createSignal<
    "loading" | "ready" | "anonymous" | "error"
  >("loading");
  const [confirmCancel, setConfirmCancel] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [expired, setExpired] = createSignal(false);
  const [preview, setPreview] = createSignal<string>();
  const [failedLocalPreview, setFailedLocalPreview] = createSignal<string>();
  const [previewStatus, setPreviewStatus] = createSignal<
    "idle" | "loading" | "unavailable"
  >("idle");
  let active = true,
    revision = 0,
    request: AbortController | undefined,
    previewRequest: AbortController | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined,
    observationTimer: ReturnType<typeof setTimeout> | undefined;
  let video: HTMLVideoElement | undefined,
    observations = 0;
  let ownedPreview: string | undefined;
  const controller = createDanceReviewController({
    ...provided.source,
    reviewId: provided.reviewId,
  });
  const ready = () =>
    phase() === "ready" ? (snapshot().context.review ?? undefined) : undefined;
  const busy = () => snapshot().matches({ review: "submitting" });
  const writeBlocked = () => busy() || snapshot().matches({ review: "error" });
  const stopPreview = () => {
    previewRequest?.abort();
    previewRequest = undefined;
    clearTimeout(previewTimer);
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    setPreview(undefined);
    if (ownedPreview) URL.revokeObjectURL(ownedPreview);
    ownedPreview = undefined;
    setPreviewStatus("idle");
  };
  const stopObservation = () => {
    clearTimeout(observationTimer);
    observationTimer = undefined;
  };
  const clear = () => {
    revision++;
    request?.abort();
    stopObservation();
    stopPreview();
    setConfirmCancel(false);
    setNotice("");
    setFailedLocalPreview(undefined);
    journey.send({ type: "ACCESS_LOST" });
    setPhase("loading");
  };
  const current = (attempt: number, signal: AbortSignal) => {
    if (
      !active ||
      signal.aborted ||
      attempt !== revision ||
      props.reviewId !== provided.reviewId
    )
      return false;
    try {
      assertCurrent(provided.source, signal);
      return true;
    } catch {
      return false;
    }
  };
  function failure(error: unknown) {
    if (privateAccessLost(error)) {
      clear();
      controller.dispose();
      setPhase("anonymous");
      provided.onAccessLost();
    } else {
      journey.send({ type: "REVIEW_ERROR", error });
      setPhase(ready() ? "ready" : "error");
    }
  }
  function apply(view: DanceReviewView) {
    assertRequestedReview(view.result, provided.reviewId);
    journey.send({ type: "REVIEW_FACT", view });
    setPhase("ready");
    if (!danceReviewEditable(view.result)) stopPreview();
  }
  function schedule() {
    stopObservation();
    const view = ready();
    if (
      !active ||
      !view ||
      !danceReviewPending(view.result) ||
      snapshot().matches({ review: "error" }) ||
      document.visibilityState === "hidden"
    )
      return;
    if (++observations > 90) {
      setNotice(
        "You can leave this screen. We’ll check for updates when you return.",
      );
      return;
    }
    observationTimer = setTimeout(() => {
      void load(false);
    }, 2000);
  }
  async function load(recover = false) {
    if (!active || phase() === "anonymous") return;
    stopObservation();
    request?.abort();
    const attempt = ++revision,
      pending = new AbortController();
    request = pending;
    try {
      const view = await (recover
        ? controller.load(pending.signal)
        : controller.observe(pending.signal));
      if (!current(attempt, pending.signal)) return;
      apply(view);
      const outstanding = await controller.hasOutstanding(pending.signal);
      if (!current(attempt, pending.signal)) return;
      if (outstanding) {
        journey.send({
          type: "REVIEW_ERROR",
          error: Error("dance_review_original_pending"),
        });
        setNotice(
          "An earlier request still needs confirmation. Resume the same submission.",
        );
      } else {
        setNotice("");
        schedule();
      }
    } catch (error) {
      if (!current(attempt, pending.signal)) return;
      if (privateAccessLost(error)) failure(error);
      else if (ready()) {
        journey.send({ type: "REVIEW_ERROR", error });
        setNotice(
          originalHoldCopy(error) ??
            "Your request could not be confirmed. Resume it without making a new submission.",
        );
      } else {
        setPhase("error");
        setNotice(
          originalHoldCopy(error) ??
            "We couldn’t confirm your recording’s status.",
        );
      }
    }
  }
  async function act(operation: "submit" | "withdraw") {
    const view = ready();
    if (!view || writeBlocked()) return;
    stopObservation();
    stopPreview();
    journey.send({ type: "REVIEW_WRITE" });
    setConfirmCancel(false);
    request?.abort();
    const pending = new AbortController(),
      attempt = ++revision;
    request = pending;
    try {
      const next = await controller.act(
        view.result,
        { operation },
        pending.signal,
      );
      if (!current(attempt, pending.signal)) return;
      apply(next);
      schedule();
    } catch (error) {
      if (!current(attempt, pending.signal)) return;
      if (privateAccessLost(error)) failure(error);
      else {
        journey.send({ type: "REVIEW_ERROR", error });
        if (
          error instanceof Error &&
          error.message === "dance_capture_expired"
        ) {
          setExpired(true);
          setNotice("This recording session has finished.");
        } else
          setNotice(
            originalHoldCopy(error) ??
              "Your request could not be confirmed. Resume it without making a new submission.",
          );
      }
    }
  }
  async function play() {
    const view = ready();
    if (!view || !danceReviewEditable(view.result)) return;
    stopPreview();
    setPreviewStatus("loading");
    const pending = new AbortController();
    previewRequest = pending;
    const attempt = revision;
    try {
      if (view.result.kind === "local_recording") {
        const original = await controller.localPreview(pending.signal);
        if (!current(attempt, pending.signal)) return;
        if (
          !Number.isSafeInteger(original.expiresAtMs) ||
          original.expiresAtMs <= Date.now()
        )
          throw Error("dance_local_preview_unavailable");
        ownedPreview = URL.createObjectURL(original.blob);
        setPreview(ownedPreview);
        setPreviewStatus("idle");
        previewTimer = setTimeout(
          stopPreview,
          original.expiresAtMs - Date.now(),
        );
        return;
      }
      if (view.result.kind !== "review")
        throw Error("dance_local_preview_unavailable");
      const review = view.result.review;
      const grant = await provided.source.media.playback(
        review,
        pending.signal,
      );
      if (!current(attempt, pending.signal)) return;
      // The admitted private progressive endpoint enforces current reviewer or
      // uploader permission for every GET, HEAD and range, not just this read.
      const path = `/api/media/${encodeURIComponent(review.receipt.mediaId)}/playback`;
      const expiry = Math.min(
        grant.expiresAtMs,
        review.receipt.reviewDeadlineMs,
      );
      if (
        grant.url !== path ||
        !Number.isSafeInteger(expiry) ||
        expiry <= Date.now()
      )
        throw Error("dance_review_media_unavailable");
      setPreview(grant.url);
      setPreviewStatus("idle");
      previewTimer = setTimeout(stopPreview, expiry - Date.now());
    } catch (error) {
      if (!current(attempt, pending.signal)) return;
      if (privateAccessLost(error)) failure(error);
      else {
        stopPreview();
        setPreviewStatus("unavailable");
      }
    }
  }
  const visibility = () => {
    if (document.visibilityState === "hidden") {
      request?.abort();
      stopObservation();
      stopPreview();
    } else {
      observations = 0;
      void load(false);
    }
  };
  const online = () => {
    observations = 0;
    void load(false);
  };
  const unsubscribeDenial = provided.source.client.onAccessLost?.((error) => {
    if (active) failure(error);
  });
  onSettled(() => {
    if (!active) return;
    void load(false);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
  });
  createEffect(
    () => [props.source.currentScope(), props.reviewId] as const,
    ([scope, id]) => {
      if (
        !scope ||
        id !== provided.reviewId ||
        danceScopeKey(scope) !== danceScopeKey(provided.source.scope)
      ) {
        clear();
        controller.dispose();
        setPhase("anonymous");
      }
    },
  );
  onCleanup(() => {
    active = false;
    unsubscribeDenial?.();
    clear();
    controller.dispose();
    subscription.unsubscribe();
    if (!provided.journey) journey.stop();
    if (!isServer) {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
    }
  });
  const localPreview = () =>
    !expired() &&
    ready() &&
    danceReviewEditable(ready()!.result) &&
    props.localPreview !== failedLocalPreview()
      ? props.localPreview
      : undefined;
  const localResult = ():
    | Extract<DanceResult, { kind: "local_recording" }>
    | undefined => {
    const r = ready()?.result;
    return r?.kind === "local_recording" ? r : undefined;
  };
  const reviewResult = ():
    | Extract<DanceResult, { kind: "review" }>
    | undefined => {
    const r = ready()?.result;
    return r?.kind === "review" ? r : undefined;
  };
  return (
    <main class="h-dvh bg-background" data-dance-review={phase()}>
      <h1 class="sr-only">Your recording</h1>
      <ActionFooterShell
        fullViewport
        header={
          <MobilePageHeader
            title="Your recording"
            density="compact"
            onBackClick={provided.onBack}
          />
        }
        bodyClass="relative flex flex-col gap-4 px-4 pt-[calc(4rem+env(safe-area-inset-top))]"
        footer={
          <div class="mx-auto grid w-full max-w-md gap-3">
            <Show when={ready()}>
              {(view) => (
                <>
                  <Show when={!expired() && view().result.state === "uploaded"}>
                    <Button
                      disabled={writeBlocked()}
                      onClick={() => void act("submit")}
                    >
                      {busy() ? "Submitting…" : "Submit for review"}
                    </Button>
                  </Show>
                  <Show
                    when={!expired() && snapshot().matches({ review: "error" })}
                  >
                    <Button disabled={busy()} onClick={() => void load(true)}>
                      Resume submission
                    </Button>
                  </Show>
                  <Show when={expired() || view().result.state !== "uploaded"}>
                    <Button variant="secondary" onClick={provided.onBack}>
                      Done
                    </Button>
                  </Show>
                </>
              )}
            </Show>
          </div>
        }
      >
        <Show when={phase() === "loading"}>
          <p aria-busy="true">Checking your recording…</p>
        </Show>
        <Show when={phase() === "anonymous"}>
          <p>Sign in to view your recording.</p>
          <Show when={props.onSignIn}>
            <Button variant="secondary" onClick={() => props.onSignIn?.()}>
              Sign in
            </Button>
          </Show>
        </Show>
        <Show when={phase() === "error"}>
          <p role="alert">We couldn’t confirm your recording’s status.</p>
          <Button variant="secondary" onClick={() => void load(false)}>
            Check again
          </Button>
          <Button onClick={() => void load(true)}>Resume submission</Button>
        </Show>
        <Show when={ready()}>
          {(view) => (
            <>
              <section
                class={
                  view().result.state === "uploaded" ? "sr-only" : "space-y-3"
                }
                aria-live="polite"
              >
                <Type as="h2" variant="h2">
                  {danceResultPresentation(view().result).title}
                </Type>
                <p>{danceResultPresentation(view().result).detail}</p>
              </section>
              <Show when={!expired() && danceReviewEditable(view().result)}>
                <Show
                  when={localPreview() || preview()}
                  fallback={
                    <Button
                      variant="secondary"
                      disabled={busy() || previewStatus() === "loading"}
                      onClick={() => void play()}
                    >
                      {previewStatus() === "loading"
                        ? "Loading recording…"
                        : "Preview recording"}
                    </Button>
                  }
                >
                  {(url) => (
                    <video
                      ref={(element) => {
                        video = element;
                        onCleanup(() => {
                          element.pause();
                          element.removeAttribute("src");
                          element.load();
                        });
                      }}
                      class="mx-auto min-h-0 w-full flex-1 bg-black object-contain"
                      src={url()}
                      controls
                      playsinline
                      preload="metadata"
                      aria-label="Your private recording"
                      onError={() => {
                        setFailedLocalPreview(props.localPreview);
                        stopPreview();
                        setPreviewStatus("unavailable");
                      }}
                    />
                  )}
                </Show>
                <Show when={previewStatus() === "unavailable"}>
                  <p role="status">
                    The preview isn’t available. You can retry.
                  </p>
                </Show>
                <Show when={localResult()} keyed>
                  {(take) => (
                    <>
                      <p class="text-sm text-muted-foreground">
                        {take.capture.rubricText}
                      </p>
                      <p class="text-sm text-muted-foreground">
                        This recording is private. Public posting is not
                        enabled.
                      </p>
                    </>
                  )}
                </Show>
              </Show>
              <Show when={reviewResult()} keyed>
                {(result) => (
                  <>
                    <Show when={danceReviewPending(result)}>
                      <p class="text-sm text-muted-foreground">
                        Review deadline:{" "}
                        <time
                          datetime={new Date(
                            result.review.receipt.reviewDeadlineMs,
                          ).toISOString()}
                        >
                          {new Date(
                            result.review.receipt.reviewDeadlineMs,
                          ).toLocaleString()}
                        </time>
                      </p>
                    </Show>
                    <Show when={danceReviewEditable(result)}>
                      <details class="text-sm">
                        <summary class="cursor-pointer text-muted-foreground">
                          Recording options
                        </summary>
                        <Button
                          variant="ghost"
                          disabled={writeBlocked()}
                          onClick={() => setConfirmCancel(true)}
                        >
                          Cancel review
                        </Button>
                      </details>
                    </Show>
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
        <Show when={notice()}>
          <p role="status">{notice()}</p>
        </Show>
      </ActionFooterShell>
      <Modal open={confirmCancel()} onOpenChange={setConfirmCancel}>
        <ModalContent>
          <ModalHeader>
            <ModalTitle>Cancel review of this recording?</ModalTitle>
          </ModalHeader>
          <p>
            Private access will stop. Any already broadcast review must still be
            reconciled.
          </p>
          <Button onClick={() => void act("withdraw")}>Cancel review</Button>
          <Button variant="secondary" onClick={() => setConfirmCancel(false)}>
            Keep waiting
          </Button>
        </ModalContent>
      </Modal>
    </main>
  );
}
