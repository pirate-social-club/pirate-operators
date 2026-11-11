import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { isServer } from "@solidjs/web";
import { createActor } from "xstate";
import type { MediaClient } from "./client.ts";
import {
  PUBLIC_POSTING_UNDECIDED,
  type PublishedMediaSong,
  type ReadyMedia,
} from "../../../../packages/community-media/contracts.ts";
import {
  MediaAttemptController,
  mediaNeedsStartOver,
  type MediaAttemptStorage,
} from "./media-attempt.ts";
import { createMediaOwnerLifetime } from "./media-owner-lifetime.ts";
import {
  createVideoComposerMachine,
  type ComposerContext,
  type ComposerOperations,
} from "./reference/src/features/posts/video-submission/video-composer-machine.ts";
import {
  VideoComposerMedia,
  type ComposerMediaOptions,
  type GuideAudio,
} from "./reference/src/features/posts/video-submission/video-composer-media.ts";
import { useOwnedActor } from "./reference/src/features/posts/video-submission/solid-actor.ts";
import { createMemoryExcerptDraftStore } from "./reference/src/features/posts/post-composer/song-excerpt-draft.ts";
import type { SongSourceReader } from "./reference/src/features/posts/post-composer/song-excerpt-source.ts";
import type { SongPickerSource } from "./reference/src/features/posts/post-composer/song-picker.tsx";
import type { SongIntervalPreflight } from "./reference/src/features/posts/video-submission/song-reference.ts";
import type { SongVideoSelection } from "./reference/src/features/posts/video-submission/contracts.ts";
import type { GuideSourcePreparation } from "./reference/src/features/posts/video-submission/buffered-guide.ts";
import {
  clipFitMessage,
  fitClipToExcerpt,
} from "./reference/src/features/posts/video-submission/clip-duration.ts";

export interface VideoComposerPorts {
  readonly storage: MediaAttemptStorage;
  readonly songReader: SongSourceReader;
  readonly songPicker: SongPickerSource;
  readonly songPreflight: SongIntervalPreflight;
  readonly prepareGuideSource: GuideSourcePreparation;
  /** Resolve a genuine selected Post to its published decentralized song.
   * Must bind songKey/revision/audio digest/community; no synthetic Post IDs. */
  readonly resolveSong: (
    selection: SongVideoSelection,
    signal: AbortSignal,
  ) => Promise<{
    readonly version: "pirate.video-song-resolution/1";
    readonly sourcePostId: string;
    readonly audioRevision: number;
    readonly song: PublishedMediaSong;
  }>;
  readonly device?: Partial<
    Pick<
      ComposerMediaOptions,
      | "openPreview"
      | "startCapture"
      | "createGuideAudio"
      | "alignTake"
      | "inspectFile"
      | "measureDuration"
    >
  >;
}
export interface VideoFlowProps {
  readonly accountId: string;
  readonly communityId: string;
  readonly client: MediaClient;
  readonly ports: VideoComposerPorts;
  readonly onExit: () => void;
  readonly onMediaReady?: (receipt: ReadyMedia) => void;
}

/** The pinned statechart is the sole video flow owner. This projection binds
 * its ComposerOperations seam to actual media HTTP and browser device ports. */
export function useCommunityVideoFlow(props: VideoFlowProps) {
  const owner = {
    accountId: props.accountId,
    communityId: props.communityId,
    client: props.client,
    ports: props.ports,
    onExit: props.onExit,
    onMediaReady: props.onMediaReady,
  };
  const lifetime = createMediaOwnerLifetime(
    owner.accountId,
    owner.communityId,
    () => props,
  );
  const notifyReady = lifetime.capture();
  const exit = () => {
    if (lifetime.current()) owner.onExit();
  };
  const mobile = Boolean(
    globalThis.matchMedia?.("(pointer: coarse) and (max-width: 767px)").matches,
  );
  const excerptStore = createMemoryExcerptDraftStore();
  const songPreflight: SongIntervalPreflight = async (input, signal) => {
    const response = await owner.ports.songPreflight(input, signal);
    if (response.song_post_id !== input.body.song_post_id)
      throw new Error("The song couldn’t be confirmed. Nothing was uploaded.");
    if (response.state !== "ready") return response;
    const interval = input.body.interval;
    // Independently versioned public clip bounds, never Dance's 6–30s intake.
    const policy = {
      ...response.interval_policy,
      min_clip_duration_samples: Math.max(
        3 * 48000,
        response.interval_policy.min_clip_duration_samples,
      ),
      max_clip_duration_samples: Math.min(
        15 * 48000,
        response.interval_policy.max_clip_duration_samples,
      ),
    };
    if (
      interval &&
      interval.clip_duration_samples < policy.min_clip_duration_samples
    )
      return {
        ...response,
        interval_policy: policy,
        interval: { accepted: false, reason: "interval_too_short" },
      };
    if (
      interval &&
      interval.clip_duration_samples > policy.max_clip_duration_samples
    )
      return {
        ...response,
        interval_policy: policy,
        interval: { accepted: false, reason: "interval_too_long" },
      };
    return { ...response, interval_policy: policy };
  };
  const [preview, setPreview] = createSignal<string>();
  const [originalPreview, setOriginalPreview] = createSignal<string>();
  const [stream, setStream] = createSignal<MediaStream | null>(null, {
    ownedWrite: true,
  });
  const [viewfinderStalled, setViewfinderStalled] = createSignal(false);
  let disposed = false;
  let previewEligibility: boolean | undefined;
  let viewfinder: HTMLVideoElement | undefined;
  const clearPreviewUrls = () => {
    if (preview()) URL.revokeObjectURL(preview()!);
    if (originalPreview()) URL.revokeObjectURL(originalPreview()!);
    setPreview(undefined);
    setOriginalPreview(undefined);
  };
  const showFile = (file: File) => {
    if (disposed) return;
    if (preview()) URL.revokeObjectURL(preview()!);
    setPreview(URL.createObjectURL(file));
  };
  // The exact returned recording is used by the machine operation; no read of
  // a deferred Solid signal is used to decide which bytes to upload.
  const controller = new MediaAttemptController({
    client: props.client,
    storage: props.ports.storage,
    accountId: props.accountId,
    communityId: props.communityId,
    onChange: (record, notificationCurrent) => {
      lifetime.queue(notificationCurrent, () =>
        actor.send({ type: "RECORD_CHANGED", record }),
      );
    },
    onReady: (receipt, notificationCurrent) => {
      if (notifyReady() && notificationCurrent()) owner.onMediaReady?.(receipt);
    },
    isCurrentOwner: lifetime.current,
  });
  const media = new VideoComposerMedia({
    ...props.ports.device,
    prepareGuideSource: props.ports.prepareGuideSource,
    canCapture: () => operations.canCapture(actor.getSnapshot().context),
    onStream: (next) => {
      if (lifetime.current()) setStream(next);
    },
    onOriginalTake: (file) => {
      if (!lifetime.current()) return;
      if (originalPreview()) URL.revokeObjectURL(originalPreview()!);
      setOriginalPreview(URL.createObjectURL(file));
    },
    onFailure: (reason, issue) =>
      send({ type: "CAPTURE_FAILURE", reason, issue }),
    onLimit: () => send({ type: "CAPTURE_LIMIT" }),
    onInterrupted: () => send({ type: "INTERRUPT" }),
  });
  const approvedFor = (context: ComposerContext) => {
    if (context.songPlan.kind !== "ready" || !context.selection)
      return undefined;
    const selected = context.songPlan.selection;
    return selected.songPostId === context.selection.songPostId &&
      selected.clipStartSamples === context.selection.bounds.startMs * 48 &&
      selected.clipDurationSamples ===
        (context.selection.bounds.endMs - context.selection.bounds.startMs) *
          48 &&
      selected.clipDurationSamples >= 3 * 48000 &&
      selected.clipDurationSamples <= 15 * 48000
      ? selected
      : undefined;
  };
  const clipProblemFor = (context: ComposerContext) => {
    const fit = fitClipToExcerpt(
      context.clipDurationMs,
      context.selection?.bounds,
    );
    return fit.kind === "too_short" || fit.kind === "too_long"
      ? clipFitMessage(fit)
      : undefined;
  };
  const mismatchFor = (context: ComposerContext) =>
    Boolean(
      context.takeSoundtrack &&
        context.selection &&
        (context.takeSoundtrack.songPostId !== context.selection.songPostId ||
          context.takeSoundtrack.bounds.startMs !==
            context.selection.bounds.startMs ||
          context.selection.bounds.endMs > context.takeSoundtrack.bounds.endMs),
    );
  const operations: ComposerOperations = {
    async restore(signal) {
      try {
        await controller.restore();
      } catch (error) {
        if (!controller.current) throw error;
      }
      const record = controller.current;
      if (!signal.aborted && record) showFile(record.file);
      // Reconciliation retains the same identity; restoring never creates a
      // new attempt or reports media readiness as public publication.
      return { record, released: false, resume: false };
    },
    checkPlayback: async (selection, signal) => {
      if (mobile) await media.checkPlayback(selection, signal);
    },
    inspectFile: async (file, signal) => {
      const take = await media.inspectFile(file, signal);
      if (!signal.aborted) showFile(take.file);
      return take;
    },
    prepareGuide: (selection, signal) => media.prepareGuide(selection, signal),
    startCapture: (prepared, signal) => media.startCapture(prepared, signal),
    startGuide: (started, signal) => media.startGuide(started, signal),
    finishCapture: async (context, signal) => {
      const take = await media.finishCapture(context, signal);
      if (!signal.aborted) showFile(take.file);
      return take;
    },
    cancelCapture: () => media.cancelCapture(),
    async publish(context, signal) {
      const abort = () => controller.pause();
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        if (!controller.current) {
          const selection = approvedFor(context);
          if (
            !context.file ||
            !selection ||
            mismatchFor(context) ||
            clipProblemFor(context) ||
            context.takeAlignment === "unaligned"
          )
            throw new Error("Choose a different part of the song.");
          const resolved = await owner.ports.resolveSong(selection, signal);
          if (
            resolved.version !== "pirate.video-song-resolution/1" ||
            resolved.sourcePostId !== selection.songPostId ||
            resolved.audioRevision !== selection.audioRevision ||
            resolved.song.communityId !== owner.communityId
          )
            throw new Error(
              "The song changed. Choose it again before recording.",
            );
          await controller.begin({
            file: context.file,
            rating: context.rating,
            song: resolved.song,
            startSample: selection.clipStartSamples,
            durationSamples: selection.clipDurationSamples,
          });
        }
        signal.throwIfAborted();
        await controller.submit();
        // Media readiness is not a public Post acknowledgement. This port has
        // no published Post ID/href, so the reference machine retains it.
        return { posted: false };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    async startOver() {
      await controller.startOver();
    },
    async refresh() {
      await controller.refresh();
      return false;
    },
    canCapture: (context) =>
      Boolean(props.accountId && props.communityId && approvedFor(context)),
    canPublish: (context) =>
      Boolean(controller.current) ||
      Boolean(
        PUBLIC_POSTING_UNDECIDED.allowed &&
          context.file &&
          approvedFor(context) &&
          !clipProblemFor(context) &&
          !mismatchFor(context) &&
          context.takeAlignment !== "unaligned",
      ),
    shouldRefresh: (context) =>
      Boolean(
        !context.record?.authenticationHold &&
          (context.record?.pending ||
            ["receiving", "queued", "processing"].includes(
              context.record?.status?.state ?? "",
            )),
      ),
    onPosted: exit,
    onExit: exit,
    onReset: () => {
      clearPreviewUrls();
      media.closePreview();
    },
    syncPreview: () => {
      if (mobile && previewEligibility)
        media.ensurePreview(
          () =>
            !disposed &&
            previewEligibility === true &&
            document.visibilityState !== "hidden",
        );
      else media.closePreview();
    },
    closePreview: () => media.closePreview(),
    discardPrepared: () => media.discardPrepared(),
  };
  const actor = createActor(
    createVideoComposerMachine(
      operations,
      isServer || document.visibilityState !== "hidden",
    ),
  );
  const { snapshot, send } = useOwnedActor(actor);
  createEffect(
    () => [props.accountId, props.communityId] as const,
    (identity) => {
      if (
        identity[0] !== owner.accountId ||
        identity[1] !== owner.communityId
      ) {
        lifetime.dispose();
        controller.dispose();
        media.dispose();
        clearPreviewUrls();
      }
    },
  );
  const model = () => snapshot().context;
  const inCapture = (phase: string) =>
    snapshot().matches({ capture: phase as "idle" });
  const record = () => model().record;
  const file = () => model().file;
  const busy = () =>
    ["restoring", "checkingPlayback", "submitting", "startingOver"].some(
      (state) => snapshot().value === state,
    ) ||
    ["preparingGuide", "startingCapture", "startingGuide", "inspecting"].some(
      inCapture,
    );
  const finalizing = () => inCapture("finalizing");
  const selection = () => model().selection;
  const completedUpload = () =>
    ["queued", "processing", "ready"].includes(record()?.status?.state ?? "") &&
    !record()?.pending;
  const playLive = (element: HTMLVideoElement) => {
    const notify = lifetime.capture();
    void element.play()?.then(
      () => {
        if (notify()) setViewfinderStalled(false);
      },
      () => {
        if (notify()) setViewfinderStalled(true);
      },
    );
  };
  const bindViewfinder = (element: HTMLVideoElement) => {
    viewfinder = element;
    element.srcObject = untrack(stream);
    if (element.srcObject) playLive(element);
  };
  createEffect(
    () => stream(),
    (next) => {
      if (viewfinder && viewfinder.isConnected) {
        viewfinder.srcObject = next;
        if (next) playLive(viewfinder);
      }
    },
  );
  // Same preview-lifetime interaction as the pinned session controller.
  const previewWanted = () =>
    mobile &&
    (inCapture("idle") ||
      inCapture("preparingGuide") ||
      inCapture("startingCapture")) &&
    operations.canCapture(model()) &&
    model().visible &&
    !record() &&
    !file() &&
    model().issue === null;
  createEffect(
    () => previewWanted(),
    (wanted) => {
      if (wanted === previewEligibility) return;
      previewEligibility = wanted;
      send({ type: "PREVIEW_CHECK" });
    },
  );
  const visibility = () =>
    send({
      type: "VISIBILITY",
      visible: document.visibilityState !== "hidden",
    });
  if (!isServer) document.addEventListener("visibilitychange", visibility);
  onCleanup(() => {
    disposed = true;
    lifetime.dispose();
    controller.dispose();
    media.dispose();
    clearPreviewUrls();
    if (!isServer) document.removeEventListener("visibilitychange", visibility);
  });
  // The original composition consumes accessors; no replacement UI statechart.
  return {
    mobile,
    excerptStore,
    songPreflight,
    personasForDestination: () => [],
    chosenCommunityId: () => props.communityId,
    chosenPersonaId: () => props.accountId,
    preview,
    originalPreview,
    stream,
    viewfinderStalled,
    bindViewfinder,
    playLive,
    record,
    file,
    submittedFromReview: () => model().submittedFromReview,
    busy,
    error: () =>
      model().error ||
      (!PUBLIC_POSTING_UNDECIDED.allowed
        ? "Video posts aren’t available right now."
        : ""),
    progress: () => model().progress,
    captureStatus: () =>
      inCapture("recording") || inCapture("startingGuide")
        ? ("recording" as const)
        : (model().issue ?? ("idle" as const)),
    selection,
    clipDurationMs: () => model().clipDurationMs,
    measuring: () => inCapture("inspecting"),
    finalizing,
    songPlan: () => model().songPlan,
    songSheetOpen: () =>
      snapshot().matches("choosingSong") ||
      snapshot().matches("checkingPlayback"),
    takeAlignment: () => model().takeAlignment,
    confirmingSound: () => model().confirmRequested,
    checkingPlayback: () => snapshot().matches("checkingPlayback"),
    playbackFailed: () => model().playbackFailed,
    panelShown: () => model().issue !== null,
    songActive: () => model().songChoice.kind !== "none",
    songSheetTitle: () => (selection() ? "Song" : "Choose a song"),
    songLabel: () => selection()?.title,
    approvedSelection: () => approvedFor(model()),
    clipProblem: () => clipProblemFor(model()),
    takeMismatch: () => mismatchFor(model()),
    profileReady: () => Boolean(props.accountId && props.communityId),
    interactionBusy: () => busy() || finalizing(),
    editing: () => !record(),
    reservationExpired: () => record()?.status?.state === "expired",
    needsStartOver: () => mediaNeedsStartOver(record()),
    otherDestination: () => false,
    reviewVisible: () => file() !== null && !record(),
    uploadUnconfirmed: () => Boolean(record()?.pending),
    completedUpload,
    statusText: () =>
      record()?.authenticationHold
        ? "Reconnect your community account before continuing."
        : record()?.pending === "withdraw"
          ? "This video is being withdrawn. Playback is unavailable."
          : record()?.pending
            ? "We couldn’t confirm this upload yet. Your video is saved here. Try again to resume the same upload."
            : ["withdrawn", "revoked", "expired"].includes(
                  record()?.status?.state ?? "",
                )
              ? "This video is no longer available. Start over."
              : record()?.status?.state === "failed" &&
                  !record()?.status?.canRetry
                ? "This video couldn’t be processed. Start over."
                : record()?.rejection
                  ? "This video wasn’t accepted."
                  : completedUpload()
                    ? "Your video has uploaded."
                    : busy()
                      ? "Uploading video…"
                      : "Your video couldn’t upload. Try again.",
    posted: exit,
    clearPreviewUrls,
    openSongSheet: () => send({ type: "OPEN_SONG" }),
    confirmSound: () => send({ type: "CONTINUE" }),
    chooseFile: (file?: File) => {
      if (file) send({ type: "FILE", file });
    },
    toggleCapture: () =>
      send({
        type:
          inCapture("recording") || inCapture("startingGuide")
            ? "STOP"
            : "RECORD",
      }),
    publish: () => send({ type: "PUBLISH" }),
    send,
  };
}
export interface VideoComposerSurfaceProps {
  readonly flow: ReturnType<typeof useCommunityVideoFlow>;
  readonly communityId: string;
  readonly songReader: SongSourceReader;
  readonly songPicker: SongPickerSource;
  readonly onExit: () => void;
  readonly personaOptions?: readonly { id: string }[];
  readonly initialSong?: {
    readonly postId: string;
    readonly communityId?: string;
  };
  readonly freshVideo?: {
    readonly song?: {
      readonly postId: string;
      readonly communityId?: string;
    } | null;
  };
  readonly createGuideAudio?: (url: string) => GuideAudio;
}
