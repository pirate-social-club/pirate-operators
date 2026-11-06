// Independently adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-capture-lifecycle.ts; see docs/karaoke-capture-handoff.md.
/**
 * Phase 5.2.4 — wires a {@link KaraokeMicCapture} engine to the transport's
 * capture hooks (SPEC §4.3/§4.4/§6). This is the single place that orders the
 * acknowledged transitions:
 *
 *   resume / initial activate : setCaptureAnchor(now) → capture.activate()
 *   suspend (reconnect/token)  : capture.deactivateAndFlush() → clearCaptureAnchor()
 *   teardown (terminal)        : capture.stop()
 *
 * The anchor is taken at the moment of (re)activation from the live capture clock
 * + the current song position/rate — never at pause (SPEC §4.3). The transport
 * `client` is attached after it's constructed (it's built with these hooks), so
 * `attachClient` resolves the chicken-and-egg.
 */

export interface CaptureEngineLike {
  captureClockMs(): number;
  /** Activates emission using `startTimeMs` as the DSP start; defaults to the live clock. */
  activate(startTimeMs?: number): Promise<unknown>;
  deactivateAndFlush(): Promise<void>;
  stop(): Promise<void>;
}

export interface CaptureAnchorSink {
  setCaptureAnchor(anchor: { captureMs: number; songMs: number; playbackRate: number }): void;
  clearCaptureAnchor(): void;
}

export interface KaraokeCaptureLifecycleOptions {
  capture: CaptureEngineLike;
  /** Current SONG-time position (ms) — sampled at (re)activation to build the anchor. */
  getSongMs: () => number;
  /** Current playback rate (default 1). */
  getPlaybackRate?: () => number;
  isPlaying?: () => boolean;
  onAnchor?: (anchor: { captureMs: number; songMs: number; playbackRate: number }) => void;
  onError?: (error: { code: string; message: string }) => void;
}

export interface KaraokeCaptureLifecycle {
  /** Late-bind the transport (which is constructed with these hooks). */
  attachClient(client: CaptureAnchorSink): void;
  /** Initial activation owner (SPEC §4.3): call when the first socket reaches live. */
  activateInitial(): Promise<void>;
  /** Transport `resumeCapture` hook (reconnect resume). */
  resumeCapture(): Promise<void>;
  /** Transport `suspendCapture` hook (deactivate + flush, then clear the anchor). */
  suspendCapture(): Promise<void>;
  /** Transport `teardownCapture` hook (full stop). */
  teardownCapture(): Promise<void>;
}

export function createKaraokeCaptureLifecycle(options: KaraokeCaptureLifecycleOptions): KaraokeCaptureLifecycle {
  const { capture } = options;
  const getPlaybackRate = options.getPlaybackRate ?? (() => 1);
  let client: CaptureAnchorSink | null = null;
  let stopped = false;
  let teardown: Promise<void> | null = null;

  const anchorAndActivate = async (): Promise<void> => {
    if (stopped) return;
    if (options.isPlaying && !options.isPlaying()) return;
    if (!client) {
      options.onError?.({ code: "karaoke_capture_not_attached", message: "capture lifecycle has no transport client" });
      return;
    }
    // Sample the capture clock ONCE and use it for BOTH the anchor and the DSP
    // start time, so they can't diverge (audit F1). Anchor is installed (sync)
    // BEFORE activate() tells the worklet to emit, so no audio flows unanchored
    // (SPEC §4.3).
    const captureMs = capture.captureClockMs();
    const anchor = {
      captureMs,
      playbackRate: getPlaybackRate(),
      songMs: options.getSongMs(),
    };
    options.onAnchor?.(anchor);
    client.setCaptureAnchor(anchor);
    await capture.activate(captureMs);
  };

  return {
    activateInitial: anchorAndActivate,
    attachClient: (next) => {
      client = next;
    },
    resumeCapture: anchorAndActivate,
    suspendCapture: async () => {
      if (stopped) return;
      // Stop emission + drain the worklet first, then clear the anchor so paused
      // capture-clock time is never folded into song time (SPEC §4.3).
      await capture.deactivateAndFlush();
      client?.clearCaptureAnchor();
    },
    teardownCapture: () => {
      if (teardown) return teardown;
      stopped = true;
      teardown = capture.stop();
      return teardown;
    },
  };
}
