import {
  startOriginalVideoCapture,
  VideoCaptureError,
  type OriginalVideoCaptureInput,
  type VideoCaptureSession,
} from "./platform/capture.ts";
import type { DanceCaptureGuide } from "./dance-capture-guide.ts";
import { boundDanceRecording } from "./dance-capture-media.ts";
import type { DancePreparationView } from "./dance-preparation-controller.ts";
import { isNoPoseDanceWindow } from "./dance-capture-window.ts";

export interface DanceRecordedTake {
  readonly sessionId: string;
  readonly termsHash: string;
  readonly durationMs: number;
  readonly file: File;
}
export interface DanceCaptureHandle {
  readonly result: Promise<DanceRecordedTake>;
  cancel(): void;
}

/** Takes custody of the preview stream and prepared guide, including failure.
 * Consent and the fresh capture lease are prerequisites. It never stores,
 * uploads, silently restarts or substitutes a chosen file for this take. */
export function startDanceCapture(
  input: {
    readonly ready: Extract<DancePreparationView, { kind: "capture_ready" }>;
    readonly stream: MediaStream;
    readonly guide: DanceCaptureGuide;
    readonly signal: AbortSignal;
    readonly onProgress?: (elapsedMs: number) => void;
  },
  dependencies: {
    readonly startCapture?: (
      input: OriginalVideoCaptureInput,
    ) => Promise<VideoCaptureSession>;
    readonly boundRecording?: typeof boundDanceRecording;
  } = {},
): DanceCaptureHandle {
  const session = {
    ...input.ready.context.session,
    cue: { ...input.ready.context.session.cue },
  };
  const controller = new AbortController(),
    tracks = input.stream.getTracks();
  let capture: VideoCaptureSession | null = null;
  let stopped = false,
    finishing = false,
    guideStarted = false;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  const covered = { video: 0, audio: 0 };
  let resolve!: (take: DanceRecordedTake) => void,
    reject!: (error: unknown) => void;
  const result = new Promise<DanceRecordedTake>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const current = () => {
    input.signal.throwIfAborted();
    controller.signal.throwIfAborted();
    input.ready.assertCurrent();
    if (stopped) throw new Error("dance_capture_ended");
  };
  const cleanup = () => {
    clearTimeout(finishTimer);
    clearInterval(watch);
    input.signal.removeEventListener("abort", aborted);
    input.guide.dispose();
    for (const track of tracks) track.stop();
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    cleanup();
    void capture?.cancel().catch(() => {});
    reject(
      error instanceof VideoCaptureError &&
        error.reason === "capability_unavailable"
        ? new Error("dance_capture_unavailable")
        : error,
    );
  };
  const aborted = () =>
    fail(
      input.signal.reason ??
        new DOMException("Recording cancelled", "AbortError"),
    );
  const finish = async () => {
    if (stopped || finishing || !capture) return;
    finishing = true;
    try {
      current();
      const original = await capture.stop();
      current();
      const file = await (dependencies.boundRecording ?? boundDanceRecording)({
        file: original,
        window: session,
        maximumBytes: session.maximum_bytes,
        signal: controller.signal,
        assertCurrent: current,
      });
      current();
      stopped = true;
      cleanup();
      resolve({
        sessionId: session.session_id,
        termsHash: session.terms_hash,
        durationMs: session.body_end_ms,
        file,
      });
    } catch (error) {
      fail(error);
    }
  };
  const scheduleFinish = () => {
    if (
      !stopped &&
      !finishing &&
      finishTimer === undefined &&
      capture &&
      covered.video >= session.body_end_ms &&
      covered.audio >= session.body_end_ms
    ) {
      // Let the synchronous source callback submit its current sample first.
      // Finalization and encoded packet verification, not this observation,
      // decide whether the complete take really exists.
      finishTimer = setTimeout(() => {
        void finish();
      }, 0);
    }
  };
  input.signal.addEventListener("abort", aborted, { once: true });
  watch = setInterval(() => {
    try {
      current();
    } catch (error) {
      fail(error);
    }
  }, 100);
  void (async () => {
    current();
    if (
      input.ready.session.state !== "consented" ||
      session.state !== "consented" ||
      session.session_id !== input.ready.session.session_id ||
      session.terms_hash !== input.ready.session.terms_hash ||
      input.guide.sessionId !== session.session_id ||
      input.guide.termsHash !== session.terms_hash
    )
      throw new Error("dance_capture_target_changed");
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    )
      throw new Error("dance_capture_interrupted");
    const started = await (
      dependencies.startCapture ?? startOriginalVideoCapture
    )({
      stream: input.stream,
      videoFirst: isNoPoseDanceWindow(session),
      limitMs: session.body_end_ms + 1500,
      onFailure: fail,
      onLimit: () => fail(new Error("dance_capture_incomplete")),
      onSourceSample(sample) {
        try {
          current();
          // A native camera's first VideoFrame can have no duration. It still
          // establishes the shared origin, but contributes no covered time.
          // Subsequent samples and the encoded-file check must prove coverage.
          if (
            !Number.isFinite(sample.timestampMs) ||
            !Number.isFinite(sample.durationMs) ||
            sample.timestampMs < 0 ||
            sample.durationMs < 0 ||
            (sample.kind === "audio" && sample.durationMs === 0)
          )
            throw new Error("dance_capture_incomplete");
          if (!guideStarted) {
            if (
              isNoPoseDanceWindow(session) &&
              (sample.kind !== "video" ||
                Math.round(sample.timestampMs * 1000) !== 0)
            )
              throw new Error("dance_capture_incomplete");
            input.guide.start(sample.originMs, current, fail);
            guideStarted = true;
          }
          covered[sample.kind] = Math.max(
            covered[sample.kind],
            sample.timestampMs + sample.durationMs,
          );
          if (sample.kind === "video")
            input.onProgress?.(
              Math.min(session.body_end_ms, sample.timestampMs),
            );
          scheduleFinish();
        } catch (error) {
          fail(error);
          throw error;
        }
      },
    });
    capture = started;
    if (stopped) {
      await started.cancel();
      return;
    }
    current();
    scheduleFinish();
  })().catch(fail);
  return {
    result,
    cancel: () => fail(new DOMException("Recording cancelled", "AbortError")),
  };
}
