import {
  VIDEO_DURATION_TIMEOUT_MS,
  withVideoPreparationDeadline,
} from "./video-preparation-deadline.ts";
import type { SoundtrackSelection } from "../post-composer/song-excerpt-composer.tsx";
import { isServer } from "@solidjs/web";
import type {
  OriginalVideoCaptureInput,
  VideoCaptureSession,
} from "./capture.ts";
import {
  captureStopAfterMs,
  GUIDED_TAKE_MAX_DURATION_SECONDS,
} from "./clip-duration.ts";
import type { GuideSourcePreparation } from "./buffered-guide.ts";
import {
  alignGuidedTake,
  type GuidedTakeAlignment,
} from "./guided-take-alignment.ts";
import { VideoCaptureError } from "./capture-failure.ts";
import type {
  CaptureIssue,
  ComposerContext,
  TakeAlignment,
} from "./video-composer-machine.ts";

export interface GuideAudio {
  currentTime: number;
  preload?: string;
  readonly readyState?: number;
  readonly buffered?: {
    readonly length: number;
    start: (index: number) => number;
    end: (index: number) => number;
  };
  play: () => Promise<void>;
  pause: () => void;
  addEventListener: (type: GuideAudioEvent, listener: () => void) => void;
  removeEventListener: (type: GuideAudioEvent, listener: () => void) => void;
}
type GuideAudioEvent =
  | "error"
  | "waiting"
  | "stalled"
  | "playing"
  | "progress"
  | "canplaythrough";

export const GUIDE_BUFFER_TIMEOUT_MS = 12_000;
export const GUIDE_START_TIMEOUT_MS = 1_500;
export const GUIDE_START_MAX_DELAY_MS = 750;
const GUIDE_WAIT_CONFIRM_MS = 80;
const GUIDE_WAIT_MIN_PROGRESS_SECONDS = 0.04;

export function excerptBuffered(
  audio: GuideAudio,
  bounds: { readonly startMs: number; readonly endMs: number },
): boolean {
  if ((audio.readyState ?? 0) >= 4) return true;
  const ranges = audio.buffered;
  if (!ranges) return audio.readyState === undefined;
  const start = bounds.startMs / 1_000;
  const end = bounds.endMs / 1_000;
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= start + 0.05 && ranges.end(index) >= end - 0.05)
      return true;
  }
  return false;
}

export interface ComposerMediaOptions {
  readonly canCapture: () => boolean;
  readonly openPreview?: () => Promise<MediaStream>;
  readonly startCapture?: (
    input: OriginalVideoCaptureInput,
  ) => Promise<VideoCaptureSession>;
  readonly createGuideAudio?: (url: string) => GuideAudio;
  readonly prepareGuideSource: GuideSourcePreparation;
  readonly alignTake?: (
    file: File,
    offsetMs: number,
  ) => Promise<GuidedTakeAlignment>;
  readonly inspectFile?: (
    file: File,
    options?: { readonly maxDurationSeconds?: number },
  ) => Promise<File>;
  readonly measureDuration?: (file: File) => Promise<number | null>;
  readonly onGuideTiming?: (timing: { readonly startDelayMs: number }) => void;
  readonly onTakeAlignment?: (info: {
    readonly offsetMs: number;
    readonly trimmedMs: number;
    readonly aligned: boolean;
  }) => void;
  readonly onStream: (stream: MediaStream | null) => void;
  readonly onOriginalTake: (file: File) => void;
  readonly onFailure: (reason: string, issue: CaptureIssue | null) => void;
  readonly onLimit: () => void;
  readonly onInterrupted: () => void;
}

const stopTracks = (media: MediaStream | null) => {
  for (const track of media?.getTracks() ?? []) track.stop();
};
const aborted = () =>
  new DOMException("The operation was cancelled", "AbortError");

/** Owns only browser media handles and measured timing. The state machine
 * decides when each operation starts, whether a result is current, and which
 * screen follows it. No upload or publication state lives here. */
export class VideoComposerMedia {
  private previewStream: MediaStream | null = null;
  private previewRequest: Promise<void> | null = null;
  private previewOpening = false;
  private session: VideoCaptureSession | null = null;
  private guideAudio: GuideAudio | null = null;
  private preparedAudio: GuideAudio | null = null;
  private guidePlaying = false;
  private guideWaitTimer: ReturnType<typeof setTimeout> | undefined;
  private guideReleases = new WeakMap<GuideAudio, () => void>();
  private disposed = false;

  constructor(private readonly options: ComposerMediaOptions) {}

  private createGuide(url: string) {
    return this.options.createGuideAudio?.(url) ?? new Audio(url);
  }
  private releaseGuide(audio: GuideAudio) {
    this.guideReleases.get(audio)?.();
    this.guideReleases.delete(audio);
  }
  discardPrepared() {
    const audio = this.preparedAudio;
    this.preparedAudio = null;
    if (audio) {
      audio.pause();
      this.releaseGuide(audio);
    }
  }
  private onGuidePlaying = () => {
    this.guidePlaying = true;
  };
  private onGuideFailure = () => {
    if (!this.disposed) this.options.onInterrupted();
  };
  private onGuideWaiting = () => {
    const audio = this.guideAudio;
    if (
      this.disposed ||
      !this.guidePlaying ||
      !audio ||
      this.guideWaitTimer !== undefined
    )
      return;
    const before = audio.currentTime;
    this.guideWaitTimer = setTimeout(() => {
      this.guideWaitTimer = undefined;
      if (
        !this.disposed &&
        this.guideAudio === audio &&
        this.session &&
        audio.currentTime - before < GUIDE_WAIT_MIN_PROGRESS_SECONDS
      )
        this.options.onInterrupted();
    }, GUIDE_WAIT_CONFIRM_MS);
  };
  private stopGuide() {
    if (this.guideWaitTimer !== undefined) clearTimeout(this.guideWaitTimer);
    this.guideWaitTimer = undefined;
    const audio = this.guideAudio;
    this.guideAudio = null;
    this.guidePlaying = false;
    if (!audio) return;
    audio.removeEventListener("error", this.onGuideFailure);
    audio.removeEventListener("waiting", this.onGuideWaiting);
    audio.removeEventListener("playing", this.onGuidePlaying);
    audio.pause();
    this.releaseGuide(audio);
  }

  closePreview() {
    const open = this.previewStream;
    this.previewStream = null;
    stopTracks(open);
    if (open)
      queueMicrotask(() => {
        if (!this.disposed) this.options.onStream(null);
      });
  }

  ensurePreview(shouldKeep: () => boolean) {
    if (
      this.disposed ||
      this.previewStream ||
      this.previewOpening ||
      this.session
    )
      return;
    this.previewOpening = true;
    const open =
      this.options.openPreview ??
      (async () => (await import("./capture.ts")).openCameraPreview());
    const request = Promise.resolve()
      .then(open)
      .then(
        (media) => {
          this.previewOpening = false;
          if (this.disposed || !shouldKeep() || this.previewStream) {
            stopTracks(media);
            return;
          }
          this.previewStream = media;
          this.options.onStream(media);
        },
        (failure) => {
          this.previewOpening = false;
          if (this.disposed || !shouldKeep()) return;
          this.options.onFailure(
            failure instanceof VideoCaptureError &&
              failure.reason === "camera_denied"
              ? failure.message
              : "This browser can’t record video. Upload a video instead.",
            failure instanceof VideoCaptureError &&
              failure.reason === "camera_denied"
              ? "camera_denied"
              : "capability_unavailable",
          );
        },
      );
    this.previewRequest = request;
    void request.finally(() => {
      if (this.previewRequest === request) this.previewRequest = null;
    });
  }

  async checkPlayback(selection: SoundtrackSelection, signal: AbortSignal) {
    const audio = this.createGuide(selection.audioUrl);
    audio.currentTime = selection.bounds.startMs / 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const played = await Promise.race([
        audio.play().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), GUIDE_BUFFER_TIMEOUT_MS);
        }),
        new Promise<false>((resolve) => {
          signal.addEventListener("abort", () => resolve(false), {
            once: true,
          });
        }),
      ]);
      if (!played || signal.aborted)
        throw new Error(
          "This song won’t play. Try again or choose another song.",
        );
    } catch {
      throw new Error(
        "This song won’t play. Try again or choose another song.",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      audio.pause();
    }
  }

  async prepareGuide(
    guide: SoundtrackSelection,
    signal: AbortSignal,
  ): Promise<{ guide: SoundtrackSelection; audio: GuideAudio }> {
    let source;
    try {
      source = await this.options.prepareGuideSource(guide.songPostId, signal);
    } catch {
      throw new Error(
        "The song didn't finish loading, so recording didn't start. Check your connection and try again.",
      );
    }
    if (this.disposed || signal.aborted) {
      source.release();
      throw aborted();
    }
    let audio: GuideAudio;
    try {
      audio = this.createGuide(source.url);
    } catch {
      source.release();
      throw new Error(
        "The song didn't finish loading, so recording didn't start. Check your connection and try again.",
      );
    }
    this.guideReleases.set(audio, source.release);
    this.preparedAudio = audio;
    audio.preload = "auto";
    audio.currentTime = guide.bounds.startMs / 1_000;
    if (excerptBuffered(audio, guide.bounds)) return { guide, audio };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        audio.removeEventListener("progress", check);
        audio.removeEventListener("canplaythrough", check);
        audio.removeEventListener("error", fail);
        signal.removeEventListener("abort", fail);
        if (!ready || signal.aborted || this.disposed) {
          audio.pause();
          this.releaseGuide(audio);
          reject(
            signal.aborted
              ? aborted()
              : new Error(
                  "The song didn't finish loading, so recording didn't start. Check your connection and try again.",
                ),
          );
        } else resolve({ guide, audio });
      };
      const check = () => {
        if (excerptBuffered(audio, guide.bounds)) finish(true);
      };
      const fail = () => finish(false);
      audio.addEventListener("progress", check);
      audio.addEventListener("canplaythrough", check);
      audio.addEventListener("error", fail);
      signal.addEventListener("abort", fail, { once: true });
      const poll = setInterval(check, 250);
      const timer = setTimeout(fail, GUIDE_BUFFER_TIMEOUT_MS);
    });
  }

  releasePrepared(audio: GuideAudio | null) {
    if (this.preparedAudio === audio) this.preparedAudio = null;
    if (audio && this.guideAudio !== audio) {
      audio.pause();
      this.releaseGuide(audio);
    }
  }

  async startCapture(
    prepared: { guide: SoundtrackSelection; audio: GuideAudio },
    signal: AbortSignal,
  ) {
    if (this.previewRequest) await this.previewRequest;
    if (signal.aborted || this.disposed || !this.options.canCapture()) {
      this.closePreview();
      this.releasePrepared(prepared.audio);
      throw aborted();
    }
    if (this.preparedAudio === prepared.audio) this.preparedAudio = null;
    const handed = this.previewStream;
    this.previewStream = null;
    const start =
      this.options.startCapture ??
      (async (input: OriginalVideoCaptureInput) =>
        (await import("./capture.ts")).startOriginalVideoCapture(input));
    let session: VideoCaptureSession;
    let reported = false;
    const reportFailure = (failure: VideoCaptureError) => {
      if (reported || signal.aborted || this.disposed) return;
      reported = true;
      this.session = null;
      this.stopGuide();
      this.options.onStream(null);
      if (!this.disposed)
        this.options.onFailure(
          failure.message,
          failure.reason === "orientation_lost"
            ? "orientation_lost"
            : failure.reason === "interrupted"
              ? null
              : failure.reason === "camera_denied"
                ? "camera_denied"
                : failure.reason === "encoder_failed"
                  ? "recording_failed"
                  : "capability_unavailable",
        );
    };
    try {
      const input: OriginalVideoCaptureInput = {
        onFailure: reportFailure,
        onLimit: () => {
          if (!reported && !signal.aborted && !this.disposed)
            this.options.onLimit();
        },
        limitMs: captureStopAfterMs(prepared.guide.bounds),
        stream: handed ?? undefined,
      };
      session = await start(input);
    } catch (failure) {
      stopTracks(handed);
      this.releasePrepared(prepared.audio);
      if (!signal.aborted && failure instanceof VideoCaptureError)
        reportFailure(failure);
      throw failure;
    }
    if (
      signal.aborted ||
      this.disposed ||
      (!isServer && document.visibilityState === "hidden")
    ) {
      await session.cancel();
      this.releasePrepared(prepared.audio);
      throw aborted();
    }
    this.session = session;
    this.options.onStream(session.stream);
    return { session, prepared };
  }

  async startGuide(
    started: {
      session: VideoCaptureSession;
      prepared: { guide: SoundtrackSelection; audio: GuideAudio };
    },
    signal: AbortSignal,
  ) {
    this.stopGuide();
    const audio = started.prepared.audio;
    this.guideAudio = audio;
    audio.addEventListener("error", this.onGuideFailure);
    audio.addEventListener("waiting", this.onGuideWaiting);
    audio.addEventListener("playing", this.onGuidePlaying);
    audio.currentTime = started.prepared.guide.bounds.startMs / 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let began = false;
    try {
      began = await Promise.race([
        audio.play().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), GUIDE_START_TIMEOUT_MS);
        }),
        new Promise<false>((resolve) => {
          signal.addEventListener("abort", () => resolve(false), {
            once: true,
          });
        }),
      ]);
    } catch {
      began = false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const delayMs = Math.max(
      0,
      Math.round(performance.now() - started.session.captureOriginMs),
    );
    this.options.onGuideTiming?.({ startDelayMs: delayMs });
    if (!began || signal.aborted) this.stopGuide();
    return { started: began && !signal.aborted, delayMs };
  }

  async finishCapture(
    context: ComposerContext,
    signal: AbortSignal,
  ): Promise<{
    file: File;
    durationMs: number | null;
    alignment: TakeAlignment;
  }> {
    const current = this.session ?? context.session;
    this.session = null;
    this.stopGuide();
    if (!current)
      throw new Error("The recording couldn’t finish. Record again.");
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      stopTracks(current.stream);
      void current.cancel().catch(() => {});
      if (!this.disposed && this.session === null) this.options.onStream(null);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const take = await current.stop();
      if (signal.aborted || this.disposed) throw aborted();
      let finalTake = take;
      let alignment: TakeAlignment = "none";
      if (context.takeSoundtrack) {
        if (
          !context.guideStarted ||
          context.guideStartDelayMs > GUIDE_START_MAX_DELAY_MS
        ) {
          alignment = "unaligned";
          this.options.onTakeAlignment?.({
            offsetMs: context.guideStartDelayMs,
            trimmedMs: 0,
            aligned: false,
          });
        } else {
          const result = await (this.options.alignTake ?? alignGuidedTake)(
            take,
            context.guideStartDelayMs,
          );
          if (signal.aborted || this.disposed) throw aborted();
          let aligned = result.aligned;
          let candidate = result.file;
          if (aligned) {
            try {
              const inspect =
                this.options.inspectFile ??
                (await import("./capture.ts")).inspectVideoFile;
              await inspect(candidate, {
                maxDurationSeconds: GUIDED_TAKE_MAX_DURATION_SECONDS,
              });
            } catch {
              aligned = false;
              candidate = take;
            }
          }
          if (signal.aborted || this.disposed) throw aborted();
          finalTake = candidate;
          alignment = aligned ? "aligned" : "unaligned";
          this.options.onTakeAlignment?.({
            offsetMs: context.guideStartDelayMs,
            trimmedMs: aligned ? result.trimmedMs : 0,
            aligned,
          });
        }
      }
      if (signal.aborted || this.disposed) throw aborted();
      const durationMs = await this.measureDuration(finalTake, signal);
      if (signal.aborted || this.disposed) throw aborted();
      this.options.onOriginalTake(take);
      return { file: finalTake, durationMs, alignment };
    } catch (failure) {
      cancel();
      throw failure;
    } finally {
      signal.removeEventListener("abort", cancel);
      stopTracks(current.stream);
    }
  }

  private measureDuration(file: File, parent: AbortSignal) {
    return withVideoPreparationDeadline(
      async (signal) =>
        this.options.measureDuration
          ? this.options.measureDuration(file)
          : (await import("./capture.ts")).measureVideoDuration(file, signal),
      VIDEO_DURATION_TIMEOUT_MS,
      parent,
    );
  }

  async inspectFile(file: File, signal: AbortSignal) {
    await this.cancelCapture();
    this.closePreview();
    const inspect =
      this.options.inspectFile ??
      (await import("./capture.ts")).inspectVideoFile;
    const accepted = await inspect(file, { maxDurationSeconds: 15 });
    if (signal.aborted || this.disposed) throw aborted();
    const durationMs = await this.measureDuration(accepted, signal);
    if (signal.aborted || this.disposed) throw aborted();
    return { file: accepted, durationMs, alignment: "none" as const };
  }

  async cancelCapture() {
    const current = this.session;
    this.session = null;
    this.stopGuide();
    this.options.onStream(null);
    if (current) await current.cancel().catch(() => {});
  }

  dispose() {
    this.disposed = true;
    this.discardPrepared();
    this.closePreview();
    void this.cancelCapture();
  }
}
