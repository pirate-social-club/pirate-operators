import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { isServer } from "@solidjs/web";
import type { DanceConsentPolicy } from "../../../../packages/dance/contracts.ts";
import type { DanceClient } from "./client.ts";
import { assertDanceSurfaces, type DanceMediaUiPort } from "./media-port.ts";
import {
  createDanceLearnerController,
  type DanceLearnerState,
} from "./learner-controller.ts";
import { danceError, danceNeedsObservation } from "./presentation.ts";
import { DanceRecordingStatusSurface } from "./reference-recording-status.tsx";
import { createDanceReviewObserver } from "./review-observer.ts";
/** Actual pinned source3 capture/review surfaces, not another recorder. */
export function DancePanel(props: {
  client: DanceClient;
  accountId: string;
  songKey: string;
  offerId: string | null;
  referenceId?: string | null;
  consent: DanceConsentPolicy;
  media: DanceMediaUiPort;
  initialReviewId?: string;
  onBack: () => void;
}) {
  assertDanceSurfaces(props.media);
  let active = true;
  const account = props.accountId;
  const [observingNotice, setObservingNotice] = createSignal("");
  const [previewReady, setPreviewReady] = createSignal(false);
  function clearPrivate() {
    setPreviewReady(false);
    props.media.clearPrivate();
  }
  const [state, setState] = createSignal<DanceLearnerState>({
    phase: "capture",
    capture: null,
    take: null,
    review: null,
    busy: false,
    error: "",
  });
  let observer: ReturnType<typeof createDanceReviewObserver> | undefined;
  const controller = createDanceLearnerController({
    client: props.client,
    selection: {
      songKey: props.songKey,
      offerId: props.offerId,
      referenceId: props.referenceId ?? null,
    },
    consent: props.consent,
    record: props.media.recordPrivate,
    clearPrivate,
    current: () => active && props.accountId === account,
    changed: (next) => {
      setState(next);
      const review = next.review;
      if (
        review &&
        review.state !== "awaiting_review" &&
        review.state !== "decision_pending"
      )
        clearPrivate();
      observer?.update(
        review &&
          !/unknown|journal/.test(next.error) &&
          danceNeedsObservation(review)
          ? review.reviewId
          : null,
      );
    },
  });
  createEffect(
    () => props.accountId,
    (next) => {
      if (next === account) return;
      observer?.dispose();
      controller.clear();
      setState(controller.state);
    },
  );
  if (!isServer) {
    observer = createDanceReviewObserver({
      current: () => active && props.accountId === account,
      visible: () => document.visibilityState !== "hidden",
      refresh: (id) => controller.observe(id),
      schedule: (callback, delay) => setTimeout(callback, delay),
      cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      rested: () =>
        setObservingNotice(
          "You can leave this screen. We’ll check for updates when you return.",
        ),
    });
    const resume = () => {
      setObservingNotice("");
      observer?.visibilityChanged();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      observer?.dispose();
    });
  }
  onCleanup(() => {
    active = false;
    controller.clear();
  });
  if (!isServer) void controller.load(props.initialReviewId);
  async function play() {
    const review = state().review;
    if (!review || state().busy) return;
    clearPrivate();
    await controller.load(review.reviewId);
    const fresh = controller.state;
    if (
      active &&
      props.accountId === account &&
      fresh.phase === "submitted" &&
      !fresh.error &&
      fresh.review?.reviewId === review.reviewId &&
      (fresh.review.state === "awaiting_review" ||
        fresh.review.state === "decision_pending")
    )
      setPreviewReady(true);
  }
  const Capture = props.media.CaptureSurface,
    Review = props.media.RecordingReviewSurface;
  return (
    <Show
      when={state().phase !== "denied"}
      fallback={
        <DanceRecordingStatusSurface
          unavailable
          busy={false}
          onRetry={() => {}}
          onDone={props.onBack}
        />
      }
    >
      <Show
        when={state().review}
        fallback={
          <Show
            when={state().take}
            fallback={
              <Capture
                {...props.media.camera()}
                title="Dance"
                allowUpload={false}
                recordDisabled={
                  state().busy || props.consent.admission !== "admitted"
                }
                timerClass="rounded-none bg-transparent px-0 py-0 backdrop-blur-none"
                recordActionLabel={
                  !state().busy
                    ? "Record"
                    : props.media.camera().status === "recording"
                      ? "Recording in progress"
                      : "Starting recording"
                }
                onRecordToggle={() => void controller.record()}
                onRetake={() => void controller.reset()}
                onClose={props.onBack}
                notice={
                  <div>
                    <p>{props.consent.text}</p>
                    <p>
                      By choosing Record, I accept these Dance rules, terms and
                      privacy version.
                    </p>
                    <Show when={props.consent.admission !== "admitted"}>
                      <p role="status">
                        Dance terms are awaiting community admission.
                      </p>
                    </Show>
                    <Show when={state().error}>
                      <p role="alert">{danceError(new Error(state().error))}</p>
                    </Show>
                  </div>
                }
              />
            }
          >
            {(take) => (
              <Review
                preview={props.media.takePreview(take())}
                busy={state().busy}
                canSubmit={
                  state().phase === "preview" ||
                  state().phase === "submission_unknown"
                }
                submitLabel={
                  state().phase === "submission_unknown"
                    ? "Resume submission"
                    : "Submit for review"
                }
                error={
                  state().error
                    ? danceError(new Error(state().error))
                    : undefined
                }
                onSubmit={() => void controller.submit()}
                onBack={props.onBack}
              />
            )}
          </Show>
        }
      >
        {(r) => (
          <DanceRecordingStatusSurface
            review={r()}
            busy={state().busy}
            error={
              state().error ? danceError(new Error(state().error)) : undefined
            }
            onRetry={() => void controller.load(r().reviewId)}
            onDone={props.onBack}
            onWithdraw={() => void controller.withdraw()}
            notice={observingNotice()}
            previewReady={previewReady()}
            privatePreview={
              previewReady() ? props.media.privatePreview(r()) : null
            }
            onPreview={() => void play()}
          />
        )}
      </Show>
    </Show>
  );
}
