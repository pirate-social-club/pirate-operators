import {
  prepareBufferedGuide,
  type GuideSourcePreparation,
} from "./platform/buffered-guide.ts";
import type { DanceCaptureContext } from "./dance-preparation-api.ts";
import {
  DANCE_SOURCE_START_LIMIT_MS,
  isNoPoseDanceWindow,
  validDanceCaptureWindow,
} from "./dance-capture-window.ts";

export interface DanceCaptureGuide {
  readonly sessionId: string;
  readonly termsHash: string;
  /** Called in the Record gesture after preparation; never downloads audio. */
  activate(): Promise<void>;
  /** The recorder supplies its shared source-arrival origin, never encoder-ready
   * time. Starting this listening source does not authorize recording. */
  start(
    originMs: number,
    assertCaptureCurrent: () => void,
    onFailure: (error: Error) => void,
  ): void;
  dispose(): void;
}

/** Decode a complete fresh canonical listening grant before recording. The
 * frozen song publication is immutable; no new guide API or persisted URL. */
export async function prepareDanceCaptureGuide(
  input: {
    readonly context: DanceCaptureContext;
    readonly signal: AbortSignal;
    readonly assertCurrent: () => void;
    readonly deferActivation?: boolean;
  },
  dependencies: {
    readonly prepareSource?: GuideSourcePreparation;
    readonly createAudioContext?: () => AudioContext;
    readonly nowMs?: () => number;
  } = {},
): Promise<DanceCaptureGuide> {
  const { signal } = input;
  const {
    session_id: sessionId,
    terms_hash: termsHash,
    body_start_ms: bodyStartMs,
    body_end_ms: bodyEndMs,
  } = input.context.session;
  const {
    canonical_song_start_ms: songStartMs,
    canonical_song_end_ms: songEndMs,
  } = input.context.reference;
  const songKey = input.context.session.capture.songKey;
  const noPose = isNoPoseDanceWindow(input.context.session);
  const current = () => {
    signal.throwIfAborted();
    input.assertCurrent();
  };
  current();
  if (
    ![bodyStartMs, bodyEndMs, songStartMs, songEndMs].every(
      Number.isSafeInteger,
    ) ||
    !validDanceCaptureWindow(input.context.session) ||
    songStartMs < 0 ||
    songEndMs <= songStartMs ||
    bodyEndMs - bodyStartMs !== songEndMs - songStartMs
  )
    throw new Error("dance_guide_bounds_changed");
  const audio = (
    dependencies.createAudioContext ?? (() => new AudioContext())
  )();
  const now = dependencies.nowMs ?? (() => performance.now());
  let disposed = false,
    started = false,
    buffer: AudioBuffer | null = null;
  let node: AudioBufferSourceNode | null = null;
  let reportFailure: ((error: Error) => void) | null = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    audio.removeEventListener("statechange", stateChanged);
    if (node) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* not scheduled */
      }
      node.disconnect();
    }
    node = null;
    buffer = null;
    reportFailure = null;
    void audio.close().catch(() => {});
  };
  const failed = (error: Error) => {
    const report = reportFailure;
    dispose();
    report?.(error);
  };
  const stateChanged = () => {
    if (started && !disposed && audio.state !== "running")
      failed(new Error("dance_guide_interrupted"));
  };
  signal.addEventListener("abort", dispose, { once: true });
  audio.addEventListener("statechange", stateChanged);
  let source: Awaited<ReturnType<GuideSourcePreparation>> | null = null;
  try {
    // Resume is invoked before any await so a caller's explicit gesture can
    // unlock audio. A suspended source never silently becomes a practice take.
    if (!input.deferActivation) await audio.resume();
    current();
    if (disposed || (!input.deferActivation && audio.state !== "running"))
      throw new Error("dance_guide_unavailable");
    if (!dependencies.prepareSource)
      throw new Error("dance_guide_port_unavailable");
    source = await dependencies.prepareSource(songKey, signal);
    current();
    if (new URL(source.url).protocol !== "blob:")
      throw new Error("dance_guide_unavailable");
    const bytes = await source.blob.arrayBuffer();
    current();
    buffer = await audio.decodeAudioData(bytes);
    current();
    if (
      disposed ||
      audio.state === "closed" ||
      !Number.isFinite(buffer.duration) ||
      buffer.duration * 1000 < songEndMs
    )
      throw new Error("dance_guide_incomplete");
    return Object.freeze({
      sessionId,
      termsHash,
      async activate() {
        current();
        if (disposed || started || !buffer)
          throw new Error("dance_guide_unavailable");
        // Invoke synchronously in the deliberate Record gesture. Download and
        // decode have already finished, including on browsers that suspend audio.
        await audio.resume();
        current();
        if (disposed || audio.state !== "running")
          throw new Error("dance_guide_unavailable");
      },
      start(
        originMs: number,
        assertCaptureCurrent: () => void,
        onFailure: (error: Error) => void,
      ) {
        current();
        assertCaptureCurrent();
        if (
          disposed ||
          started ||
          !buffer ||
          audio.state !== "running" ||
          !Number.isFinite(originMs)
        )
          throw new Error("dance_guide_unavailable");
        const delaySeconds = (originMs + bodyStartMs - now()) / 1000;
        // No-pose capture has already delivered its first video sample. Keep
        // that clock: start now at the corresponding song offset, never add a
        // countdown or move either recorded track to hide source latency.
        const elapsed = noPose ? Math.max(0, -delaySeconds) : 0;
        if (
          (!noPose && delaySeconds <= 0) ||
          (noPose &&
            (delaySeconds > 0 || elapsed * 1000 > DANCE_SOURCE_START_LIMIT_MS))
        )
          throw new Error("dance_guide_start_missed");
        started = true;
        reportFailure = onFailure;
        node = audio.createBufferSource();
        node.buffer = buffer;
        node.playbackRate.value = 1;
        node.connect(audio.destination);
        const startAt = audio.currentTime + Math.max(0, delaySeconds);
        const duration = (songEndMs - songStartMs) / 1000 - elapsed;
        if (duration <= 0) {
          dispose();
          throw new Error("dance_guide_start_missed");
        }
        const endAt = startAt + duration;
        node.onended = () => {
          if (!disposed && audio.currentTime < endAt - 1 / audio.sampleRate)
            failed(new Error("dance_guide_interrupted"));
        };
        try {
          node.start(startAt, songStartMs / 1000 + elapsed, duration);
        } catch (error) {
          dispose();
          throw error;
        }
      },
      dispose,
    });
  } catch (error) {
    dispose();
    throw error;
  } finally {
    source?.release();
  }
}
