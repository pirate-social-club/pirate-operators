// Independently adapted c7 review controller/machine on Paper media-first layout:
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
  Button,
  Modal,
  ModalContent,
  ModalHeader,
  ModalTitle,
  Type,
  IconPlay,
} from "../design-system.ts";
import { DanceMediaHeader, DanceStatusHeader } from "./dance-media-header.tsx";
import { createDancePostingViewport, dancePostingAllowed } from "./dance-viewport.ts";
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
} from "./dance-review-api.ts";
import {
  assertCurrent,
  danceScopeKey,
  type DanceSourcePorts,
} from "./ports.ts";

export function DanceReviewPage(props: {
  readonly source: DanceSourcePorts;
  readonly songLabel?: string;
  readonly reviewId?: string;
  readonly localPreview?: string;
  readonly journey?: DanceJourneyActor;
  readonly onBack: () => void;
  readonly onAccessLost: () => void;
  readonly onSignIn?: () => void;
  readonly assertFreshPosting?: () => void;
}) {
  const postingAllowed = createDancePostingViewport();
  const [playing, setPlaying] = createSignal(false);
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
    assertFreshPosting: () => {
      props.assertFreshPosting?.();
      if (!dancePostingAllowed()) throw Error("dance_posting_unavailable");
    },
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
    setPlaying(false);
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
          "Your submission needs confirmation. Resume to continue.",
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
          (originalHoldCopy(error) ? "This recording needs confirmation. Resume to continue." : null) ??
            "Your submission needs confirmation. Resume to continue.",
        );
      } else {
        setPhase("error");
        setNotice(
          (originalHoldCopy(error) ? "This recording needs confirmation. Resume to continue." : null) ??
            "We couldn’t confirm your recording’s status.",
        );
      }
    }
  }
  async function act(operation: "submit" | "withdraw") {
    const view = ready();
    if (!view || writeBlocked() || (operation === "submit" && !dancePostingAllowed())) return;
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
            (originalHoldCopy(error) ? "This recording needs confirmation. Resume to continue." : null) ??
              "Your submission needs confirmation. Resume to continue.",
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
    ready()!.result.kind === "local_recording" &&
    danceReviewEditable(ready()!.result) &&
    props.localPreview !== failedLocalPreview()
      ? props.localPreview
      : undefined;
  const editable = () => !!ready() && !expired() && danceReviewEditable(ready()!.result);
  const fullMedia = () => editable() && (ready()!.result.kind === "local_recording" || !!preview());
  async function togglePlayback() {
    if (!video || !editable()) return;
    if (!video.paused) { video.pause(); return; }
    const selectedVideo = video, selectedUrl = localPreview() || preview(), attempt = revision;
    previewRequest?.abort();
    const pending = new AbortController(); previewRequest = pending;
    try {
      const fresh = await controller.observe(pending.signal);
      if (!current(attempt, pending.signal)) return;
      assertRequestedReview(fresh.result, provided.reviewId);
      if (!danceReviewEditable(fresh.result)) { apply(fresh); return; }
      if (fresh.result.kind === "local_recording") {
        if (Date.now() >= fresh.result.capture.expiresAtMs) throw Error("dance_local_preview_unavailable");
        await provided.source.captureAccess(fresh.result.capture, pending.signal);
      }
      else if (fresh.result.kind === "review") {
        const grant = await provided.source.media.playback(fresh.result.review, pending.signal);
        const path = `/api/media/${encodeURIComponent(fresh.result.review.receipt.mediaId)}/playback`;
        if (grant.url !== path || (selectedUrl?.startsWith("/api/media/") && selectedUrl !== path) || !Number.isSafeInteger(grant.expiresAtMs) || grant.expiresAtMs <= Date.now() || fresh.result.review.receipt.reviewDeadlineMs <= Date.now()) throw Error("dance_review_media_unavailable");
        clearTimeout(previewTimer);
        previewTimer = setTimeout(stopPreview, Math.min(grant.expiresAtMs, fresh.result.review.receipt.reviewDeadlineMs) - Date.now());
      }
      if (!current(attempt, pending.signal) || video !== selectedVideo || (localPreview() || preview()) !== selectedUrl || !selectedVideo.getAttribute("src")) return;
      await selectedVideo.play();
      if (!current(attempt, pending.signal)) selectedVideo.pause();
    } catch (error) {
      if (!current(attempt, pending.signal)) return;
      if (privateAccessLost(error)) failure(error);
      else { stopPreview(); setPreviewStatus("unavailable"); }
    }
  }
  return (
    <main class="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-background" data-dance-review={phase()}>
      <h1 class="sr-only">Your recording</h1>
      <Show when={fullMedia()} fallback={<DanceStatusHeader onBack={provided.onBack} />}>
        <div class="absolute inset-0 bg-[#171B1F]" />
        <DanceMediaHeader songLabel={provided.songLabel} onBack={provided.onBack} />
      </Show>
      <div class={fullMedia() ? "contents" : "relative flex min-h-0 flex-1 flex-col"}>
        <Show when={phase() === "loading"}><p class="px-4 py-12 text-center" aria-busy="true">Checking your recording…</p></Show>
        <Show when={phase() === "anonymous"}>
          <div class="flex flex-col gap-4 px-4 py-12"><p>Sign in to view your recording.</p>
            <Show when={props.onSignIn}><Button variant="secondary" onClick={() => props.onSignIn?.()}>Sign in</Button></Show>
          </div>
        </Show>
        <Show when={phase() === "error"}>
          <div class="flex flex-col gap-4 px-4 py-12"><p role="alert">We couldn’t confirm your recording’s status.</p>
            <Button variant="secondary" onClick={() => void load(false)}>Check again</Button>
            <Button onClick={() => void load(true)}>Resume submission</Button>
            <Button variant="secondary" onClick={provided.onBack}>Back to dance</Button>
          </div>
        </Show>
        <Show when={ready()}>{(view) => <>
          <Show when={!fullMedia()}>
            <section class="flex flex-col items-center gap-4 px-4 pb-10 pt-12 text-center" aria-live="polite">
              <svg aria-hidden="true" width="56" height="56" viewBox="0 0 56 56" class="text-muted-foreground"><circle cx="28" cy="28" r="24" fill="none" stroke="currentColor" stroke-width="4" /><path d="M28 15V28H38" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" /></svg>
              <Type as="h2" variant="h3">{view().result.state === "awaiting_review" ? "Submitted" : danceResultPresentation(view().result).title}</Type>
              <p>{danceResultPresentation(view().result).detail}</p>
            </section>
          </Show>
          <Show when={fullMedia()}>
            <section class="absolute inset-0" aria-label="Recording preview">
              <Show when={localPreview() || preview()} fallback={
                <button type="button" class="absolute left-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white focus-visible:outline-2 focus-visible:outline-white" disabled={busy() || previewStatus() === "loading"} onClick={() => void play()}>
                  <IconPlay aria-hidden="true" class="size-[26px]" /><span class="sr-only">{previewStatus() === "loading" ? "Loading recording…" : "Preview recording"}</span>
                </button>
              }>{(url) => <>
                <video ref={(element) => {
                  video = element;
                  onCleanup(() => { element.pause(); element.removeAttribute("src"); element.load(); });
                }} class="absolute inset-0 h-full w-full bg-[#171B1F] object-cover" src={url()} playsinline preload="metadata" aria-label="Your private recording"
                  onPlay={() => { if (ready()) setPlaying(true); else video?.pause(); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
                  onError={() => { setFailedLocalPreview(props.localPreview); stopPreview(); setPreviewStatus("unavailable"); }} />
                <button type="button" class="absolute left-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white focus-visible:outline-2 focus-visible:outline-white" onClick={() => void togglePlayback()}>
                  <Show when={playing()} fallback={<IconPlay aria-hidden="true" class="size-[26px]" />}><svg aria-hidden="true" width="26" height="26" viewBox="0 0 26 26" fill="currentColor"><rect x="6" y="4" width="5" height="18" rx="1" /><rect x="15" y="4" width="5" height="18" rx="1" /></svg></Show>
                  <span class="sr-only">{playing() ? "Pause recording" : "Play recording"}</span>
                </button>
              </>}</Show>
              <Show when={previewStatus() === "unavailable"}><p role="status" class="absolute inset-x-4 top-20 rounded-xl bg-black/70 p-4 text-center text-white">The preview isn’t available. You can retry or go back to your dance.</p></Show>
            </section>
          </Show>
        </>}</Show>
      </div>
      <footer class="relative z-20 mt-auto flex flex-col gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <Show when={notice()}><p role="status" class="rounded-xl bg-background/95 p-3 text-sm">{notice()}</p></Show>
        <Show when={ready()}>{(view) => <>
          <Show when={!expired() && view().result.state === "uploaded" && postingAllowed()}>
            <Button class="h-12 w-full rounded-xl" disabled={writeBlocked()} onClick={() => void act("submit")}>{busy() ? "Submitting…" : "Submit for review"}</Button>
          </Show>
          <Show when={!expired() && snapshot().matches({ review: "error" })}><Button class="h-12 w-full rounded-xl" disabled={busy()} onClick={() => void load(true)}>Resume submission</Button></Show>
          <Show when={editable() && !fullMedia()}><Button variant="secondary" class="h-12 w-full rounded-xl" disabled={previewStatus() === "loading"} onClick={() => void play()}>Preview recording</Button></Show>
          <Show when={view().result.kind === "review" && danceReviewEditable(view().result)}>
            <Button variant="secondary" class="h-12 w-full rounded-xl" disabled={writeBlocked()} onClick={() => setConfirmCancel(true)}>Cancel review</Button>
          </Show>
          <Show when={!postingAllowed() && view().result.state === "uploaded"}><p class="text-sm">Recording is available on mobile.</p><Button variant="secondary" onClick={provided.onBack}>Back to dance</Button></Show>
          <Show when={expired() || view().result.state !== "uploaded"}><Button class="h-12 w-full rounded-xl" variant="secondary" onClick={provided.onBack}>Done</Button></Show>
        </>}</Show>
      </footer>
      <Modal open={confirmCancel()} onOpenChange={setConfirmCancel}>
        <ModalContent><ModalHeader><ModalTitle>Cancel review of this recording?</ModalTitle></ModalHeader>
          <p>Stop review of this recording?</p>
          <Button disabled={writeBlocked()} onClick={() => void act("withdraw")}>Cancel review</Button>
          <Button variant="secondary" onClick={() => setConfirmCancel(false)}>Keep waiting</Button>
        </ModalContent>
      </Modal>
    </main>
  );
}
