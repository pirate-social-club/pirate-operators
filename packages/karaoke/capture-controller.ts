// Drives one Karaoke take's capture against the operator audio client from the
// backing track's play, pause, seek, time and finish notifications. Adapted
// from pirate-web-solid 667a6f22 scoring/karaoke-scoring-controller.ts: the
// microphone is acquired first, initial activation waits for a live socket and
// playback, local pause/seek/resume transitions are serialized, every chunk is
// mapped from capture time to song time through the playback clock, and an
// unmappable chunk aborts the take. Live line scores and summaries are not
// part of the operator socket, so their state is not carried. Two deliberate
// changes: a pause flushes the capture tail before telling the operator, where
// the centralized client sent pause first and its server dropped that tail;
// and a first chunk stamped up to ANCHOR_SLACK_MS before its epoch's anchor is
// mapped from the anchor instead of aborting the take.
// See docs/karaoke-capture-handoff.md.
import {
  createKaraokeCaptureLifecycle,
  type CaptureEngineLike,
  type KaraokeCaptureLifecycle,
} from "./capture-lifecycle.ts";
import type {
  KaraokeOperatorAudioClient,
  KaraokeOperatorClientOptions,
  KaraokeOperatorPhase,
} from "./operator-audio-client.ts";
import { KaraokePlaybackClock } from "./playback-clock.ts";

export type KaraokeCaptureStatus =
  | "idle"
  | "requesting-mic"
  | "connecting"
  | "reconnecting"
  | "active"
  | "finishing"
  | "ended"
  | "error";
export interface KaraokeCaptureError {
  code: string;
  message: string;
}
export interface KaraokeCaptureState {
  status: KaraokeCaptureStatus;
  phase: KaraokeOperatorPhase;
  micError: KaraokeCaptureError | null;
  error: KaraokeCaptureError | null;
}
export interface KaraokeCaptureEngine extends CaptureEngineLike {
  start(): Promise<void>;
}
type ClientHooks = Pick<
  KaraokeOperatorClientOptions,
  "suspendCapture" | "resumeCapture" | "onPhaseChange" | "onError" | "onMessage"
>;
export interface KaraokeCaptureControllerOptions {
  createCaptureEngine: (handlers: {
    onChunk: (pcm16: ArrayBuffer, capturedAtMs: number) => void;
    onError: (error: KaraokeCaptureError) => void;
  }) => KaraokeCaptureEngine;
  createClient: (
    hooks: ClientHooks,
  ) => Pick<
    KaraokeOperatorAudioClient,
    | "start"
    | "getPhase"
    | "pushAudio"
    | "pause"
    | "seek"
    | "finish"
    | "close"
    | "setCaptureAnchor"
    | "clearCaptureAnchor"
  >;
  /** Samples the actual media element, independently of capture delivery. */
  getPlaybackPosition?: () => { songMs: number; playbackRate: number } | null;
  /** Production waits for playing, including after stalls and reconnects. */
  deferCaptureUntilPlaying?: boolean;
  onMessage?: (message: Record<string, unknown>) => void;
}
export interface KaraokeCaptureController {
  getState(): KaraokeCaptureState;
  subscribe(listener: (state: KaraokeCaptureState) => void): () => void;
  start(startedAtAudioMs: number): Promise<void>;
  noteTime(songMs: number): void;
  notePlay(songMs: number): void;
  notePause(songMs: number): Promise<void>;
  noteSeek(songMs: number): void;
  noteFinish(songMs: number): Promise<void>;
  stop(): void;
  abort(code: string): void;
  dispose(): void;
}

/**
 * The worklet stamps chunks from the first render quantum it processes, which
 * can precede the main thread's anchor reading by about one quantum. Within
 * this slack the chunk starts at the anchor; anything earlier still aborts.
 */
export const ANCHOR_SLACK_MS = 25;

const initialState = (): KaraokeCaptureState => ({
  status: "idle",
  phase: "idle",
  micError: null,
  error: null,
});

function statusForPhase(
  phase: KaraokeOperatorPhase,
  hasBeenLive: boolean,
): KaraokeCaptureStatus {
  switch (phase) {
    case "connecting":
      return hasBeenLive ? "reconnecting" : "connecting";
    case "reconnecting":
      return "reconnecting";
    case "live":
      return "active";
    case "aborted":
      return "error";
    case "closed":
      return "ended";
    default:
      return hasBeenLive ? "ended" : "idle";
  }
}

export function createKaraokeCaptureController(
  options: KaraokeCaptureControllerOptions,
): KaraokeCaptureController {
  const playbackClock = new KaraokePlaybackClock();
  const listeners = new Set<(state: KaraokeCaptureState) => void>();
  let state = initialState();
  let client: ReturnType<
    KaraokeCaptureControllerOptions["createClient"]
  > | null = null;
  let engine: KaraokeCaptureEngine | null = null;
  let lifecycle: KaraokeCaptureLifecycle | null = null;
  let songMs = 0;
  let hasBeenLive = false;
  let activatedInitial = false;
  let isPlaying = false;
  let disposed = false;
  let captureEnded = false;
  let generation = 0;
  let localChain: Promise<void> = Promise.resolve();
  let epochCaptureMs: number | null = null;

  function setState(patch: Partial<KaraokeCaptureState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }
  function enqueueLocal(task: () => Promise<void>): Promise<void> {
    localChain = localChain.then(task, task).catch(() => undefined);
    return localChain;
  }
  function observePlayback(): void {
    const position = options.getPlaybackPosition?.();
    if (!position || !engine) return;
    songMs = Math.max(0, position.songMs);
    playbackClock.observe({ captureMs: engine.captureClockMs(), songMs });
  }
  function releaseCapture(): void {
    captureEnded = true;
    isPlaying = false;
    void (lifecycle ? lifecycle.teardownCapture() : engine?.stop());
  }
  const live = () => client?.getPhase() === "live";
  function localResume(): void {
    if (captureEnded || !lifecycle || !live()) return;
    const capture = lifecycle;
    const current = client;
    void enqueueLocal(async () => {
      if (captureEnded || client !== current || !live()) return;
      await capture.resumeCapture();
    });
  }
  function localSuspend(): Promise<void> {
    if (captureEnded || !lifecycle || !live()) return localChain;
    const capture = lifecycle;
    return enqueueLocal(() => capture.suspendCapture());
  }
  function handlePhaseChange(phase: KaraokeOperatorPhase): void {
    if (phase === "live" && !captureEnded) {
      hasBeenLive = true;
      if (!activatedInitial && lifecycle && isPlaying) {
        activatedInitial = true;
        const capture = lifecycle;
        const current = client;
        void enqueueLocal(async () => {
          if (captureEnded || client !== current || !live()) return;
          await capture.activateInitial();
        });
      }
    }
    if (phase === "closed" || phase === "aborted") releaseCapture();
    const status =
      captureEnded &&
      (phase === "live" || phase === "reconnecting" || phase === "connecting")
        ? state.status
        : statusForPhase(phase, hasBeenLive);
    setState({ phase, status });
  }
  function handleCaptureError(error: KaraokeCaptureError): void {
    releaseCapture();
    setState({ micError: error, status: "error" });
    if (hasBeenLive && live()) client?.close();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(startedAtAudioMs) {
      if (disposed) return;
      if (
        state.status !== "idle" &&
        state.status !== "ended" &&
        state.status !== "error"
      )
        return;
      const attempt = ++generation;
      client?.close();
      client = null;
      lifecycle = null;
      captureEnded = false;
      songMs = Math.max(0, startedAtAudioMs);
      isPlaying = !options.deferCaptureUntilPlaying;
      playbackClock.reset();
      hasBeenLive = false;
      activatedInitial = false;
      setState({ ...initialState(), status: "requesting-mic" });
      // 1. The microphone first, so a refused permission never opens a take.
      const captureEngine = options.createCaptureEngine({
        onChunk: (pcm16, capturedAtMs) => {
          if (attempt !== generation || disposed) return;
          if (!options.getPlaybackPosition) {
            client?.pushAudio(pcm16, capturedAtMs);
            return;
          }
          observePlayback();
          const durationMs = (pcm16.byteLength / 2 / 16_000) * 1000;
          let startMs = capturedAtMs - durationMs;
          if (
            epochCaptureMs !== null &&
            startMs < epochCaptureMs &&
            epochCaptureMs - startMs <= ANCHOR_SLACK_MS
          )
            startMs = epochCaptureMs;
          const range = playbackClock.mapRange(startMs, capturedAtMs);
          if (!range) {
            handleCaptureError({
              code: "karaoke_clock_unavailable",
              message:
                "Playback timing could not be measured. Start a new take.",
            });
            return;
          }
          client?.pushAudio(pcm16, capturedAtMs, range);
        },
        onError: (error) => {
          if (attempt === generation && !disposed) handleCaptureError(error);
        },
      });
      engine = captureEngine;
      try {
        await captureEngine.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string }).code ?? "karaoke_mic_failed";
        if (!disposed && attempt === generation)
          setState({ micError: { code, message }, status: "error" });
        void captureEngine.stop();
        if (engine === captureEngine) engine = null;
        return;
      }
      if (disposed || captureEnded || attempt !== generation) {
        void captureEngine.stop();
        if (engine === captureEngine) engine = null;
        return;
      }
      // 2. Capture transitions, anchored on the playing media.
      const captureLifecycle = createKaraokeCaptureLifecycle({
        capture: captureEngine,
        getPlaybackRate: () =>
          options.getPlaybackPosition?.()?.playbackRate ?? 1,
        getSongMs: () => options.getPlaybackPosition?.()?.songMs ?? songMs,
        isPlaying: () => isPlaying,
        onAnchor: (anchor) => {
          epochCaptureMs = anchor.captureMs;
          playbackClock.reset(anchor);
        },
        onError: (error) => {
          if (attempt === generation && !disposed) handleCaptureError(error);
        },
      });
      lifecycle = captureLifecycle;
      // 3. The operator socket, with the reconnect capture hooks attached.
      const operatorClient = options.createClient({
        onError: (error) => {
          if (attempt === generation && !disposed) setState({ error });
        },
        onMessage: (message) => {
          if (attempt === generation && !disposed) options.onMessage?.(message);
        },
        onPhaseChange: (phase) => {
          if (attempt === generation && !disposed) handlePhaseChange(phase);
        },
        resumeCapture: () => captureLifecycle.resumeCapture(),
        suspendCapture: () => captureLifecycle.suspendCapture(),
      });
      client = operatorClient;
      captureLifecycle.attachClient(operatorClient);
      setState({ status: "connecting" });
      operatorClient.start();
    },
    noteTime(nextSongMs) {
      songMs = Math.max(0, nextSongMs);
      if (isPlaying) observePlayback();
    },
    notePlay(nextSongMs) {
      songMs = Math.max(0, nextSongMs);
      if (isPlaying) return;
      isPlaying = true;
      if (captureEnded || !live()) return;
      activatedInitial = true;
      localResume();
    },
    notePause(nextSongMs) {
      songMs = Math.max(0, nextSongMs);
      isPlaying = false;
      if (captureEnded || !client || !live()) return Promise.resolve();
      const current = client;
      const pausedAt = songMs;
      // Flush the capture tail at the paused clock, then tell the operator.
      return localSuspend().then(() => {
        if (client === current && live()) current.pause(pausedAt);
      });
    },
    noteSeek(nextSongMs) {
      songMs = Math.max(0, nextSongMs);
      if (captureEnded || !client || !live()) return;
      const current = client;
      const seekTo = songMs;
      // A seek decouples capture from song time: a new epoch.
      if (isPlaying) {
        void localSuspend().then(() => {
          if (client === current && live()) current.seek(seekTo);
        });
        localResume();
      } else current.seek(seekTo);
    },
    noteFinish(nextSongMs) {
      songMs = Math.max(0, nextSongMs);
      if (captureEnded || !client || !lifecycle) return Promise.resolve();
      captureEnded = true;
      isPlaying = false;
      const current = client;
      const capture = lifecycle;
      setState({ status: "finishing" });
      // Flush the final audio while its anchor and socket are valid, release
      // the microphone, then finish; the socket stays open for the result.
      return enqueueLocal(async () => {
        try {
          await capture.suspendCapture();
        } finally {
          await capture.teardownCapture();
          if (!disposed && client === current && live()) current.finish();
        }
      });
    },
    stop() {
      releaseCapture();
      client?.close();
    },
    abort(code) {
      releaseCapture();
      client?.close();
      setState({
        error: { code, message: "Karaoke take aborted" },
        status: "error",
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      releaseCapture();
      client?.close();
    },
  };
}
