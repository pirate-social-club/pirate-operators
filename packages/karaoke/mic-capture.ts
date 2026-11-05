// Independently adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-mic-capture.ts; only imports changed.
/**
 * Phase 5.2.2 — `KaraokeMicCapture`: the main-thread microphone engine. Owns the
 * mic → AudioContext → AudioWorklet graph and the capture lifecycle:
 *
 *   start()              wires the graph; begins INACTIVE (no chunks emitted)
 *   activate()           bumps the epoch + tells the worklet to emit
 *   deactivateAndFlush() stops emission and drains the partial chunk (ACKNOWLEDGED)
 *   stop()               PERMANENT teardown — activate()/deactivateAndFlush() no-op after
 *
 * The engine OWNS the epoch: the worklet tags each chunk, and the engine forwards
 * `onChunk` ONLY for the current epoch (stale chunks dropped). `stop()` makes
 * `activate()` a permanent no-op — the contract SPEC §7 requires so a late resume
 * can never reactivate a torn-down mic. All browser APIs are injected so the engine
 * is unit-testable with a fake worklet. See `web/docs/karaoke-audio-capture.md`.
 */

import { KARAOKE_CAPTURE_CHUNK_SAMPLES } from "./capture-dsp.ts";

export type KaraokeMicErrorCode =
  | "permission_denied"
  | "no_device"
  | "device_unavailable"
  | "worklet_unavailable"
  | "unknown";

export class KaraokeMicError extends Error {
  readonly code: KaraokeMicErrorCode;
  constructor(code: KaraokeMicErrorCode, message: string) {
    super(message);
    this.name = "KaraokeMicError";
    this.code = code;
  }
}

interface MicTrack {
  stop(): void;
  onended?: ((event?: unknown) => void) | null;
}
interface MicStream {
  getTracks(): MicTrack[];
}
interface MicPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}
interface MicWorkletNode {
  readonly port: MicPort;
  connect(destination: unknown): void;
  disconnect(): void;
}
interface MicSourceNode {
  connect(node: MicWorkletNode): void;
  disconnect(): void;
}
export interface MicAudioContext {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly destination: unknown;
  resume?(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(stream: MicStream): MicSourceNode;
}

/** Injected browser surface (real implementations by default; fakes in tests). */
export interface KaraokeMicCaptureDeps {
  getUserMedia: (constraints: unknown) => Promise<MicStream>;
  createContext: () => MicAudioContext | Promise<MicAudioContext>;
  addWorkletModule: (context: MicAudioContext) => Promise<void>;
  createWorkletNode: (context: MicAudioContext) => MicWorkletNode;
  /** A playback owner may lend its context; stop still releases every mic node and track. */
  releaseContext?: (context: MicAudioContext) => Promise<void>;
}

export interface KaraokeMicCaptureOptions {
  onChunk: (pcm16: ArrayBuffer, capturedAtMs: number) => void;
  onError?: (error: { code: KaraokeMicErrorCode; message: string }) => void;
  deps: KaraokeMicCaptureDeps;
  chunkSamples?: number;
  halfTaps?: number;
  /** Max ms of render-clock progression to wait for the worklet's flush ack. */
  flushTimeoutMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type Phase = "idle" | "started" | "stopped";

const DEFAULT_FLUSH_TIMEOUT_MS = 1_000;

function mapGetUserMediaError(error: unknown): KaraokeMicError {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new KaraokeMicError("permission_denied", "Microphone permission denied");
    case "NotFoundError":
    case "OverconstrainedError":
      return new KaraokeMicError("no_device", "No microphone available");
    case "NotReadableError":
    case "AbortError":
      return new KaraokeMicError("device_unavailable", "Microphone is unavailable");
    default:
      return new KaraokeMicError("unknown", error instanceof Error ? error.message : String(error));
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class KaraokeMicCapture {
  private readonly options: KaraokeMicCaptureOptions;
  private readonly deps: KaraokeMicCaptureDeps;
  private readonly chunkSamples: number;
  private readonly halfTaps: number | undefined;
  private readonly flushTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private phase: Phase = "idle";
  private epoch = 0; // 0 = never activated; bumped by activate() and stop()
  private active = false;
  private stopped = false;
  private context: MicAudioContext | null = null;
  private stream: MicStream | null = null;
  private node: MicWorkletNode | null = null;
  private source: MicSourceNode | null = null;
  private pendingFlush: { epoch: number; resolve: () => void } | null = null;

  constructor(options: KaraokeMicCaptureOptions) {
    this.options = options;
    this.deps = options.deps;
    this.chunkSamples = options.chunkSamples ?? KARAOKE_CAPTURE_CHUNK_SAMPLES;
    this.halfTaps = options.halfTaps;
    this.flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Capture clock in ms (AudioContext time), used as the anchor's captureMs. */
  captureClockMs(): number {
    return this.context ? this.context.currentTime * 1000 : this.now();
  }

  /** Wires the mic graph; begins INACTIVE. Throws a typed `KaraokeMicError` on failure. */
  async start(): Promise<void> {
    if (this.stopped) throw new KaraokeMicError("unknown", "capture already stopped");
    if (this.phase !== "idle") return;

    let stream: MicStream;
    try {
      stream = await this.deps.getUserMedia(this.captureConstraints());
    } catch (error) {
      throw this.report(mapGetUserMediaError(error));
    }
    this.stream = stream;
    for (const track of stream.getTracks()) {
      track.onended = () => this.handleTrackEnded();
    }

    // All graph construction is guarded by ONE cleanup-on-failure path so a
    // failure after context creation (addModule, node, source, connect, configure)
    // never leaks the AudioContext or graph (audit F2).
    try {
      this.context = await this.deps.createContext();
      await this.deps.addWorkletModule(this.context);
      this.node = this.deps.createWorkletNode(this.context);
      this.source = this.context.createMediaStreamSource(this.stream);
      this.source.connect(this.node);
      this.node.connect(this.context.destination);
      this.node.port.onmessage = (event) => this.handleMessage(event.data);
      this.node.port.postMessage({
        chunkSamples: this.chunkSamples,
        halfTaps: this.halfTaps,
        inputRate: this.context.sampleRate,
        type: "configure",
      });
    } catch (error) {
      await this.cleanupGraph();
      // Surface the underlying cause: in production builds the AudioWorklet module
      // can fail to load (e.g. emitted-asset import resolution), which is otherwise
      // collapsed into a generic "mic could not be started" message.
      if (typeof console !== "undefined") {
        console.error(`[karaoke-capture] audio graph / AudioWorklet setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw this.report(new KaraokeMicError("worklet_unavailable", stringifyError(error)));
    }
    this.phase = "started"; // inactive: no chunks until activate()
  }

  /**
   * Begins emission under a fresh epoch, stamping the worklet's DSP start time
   * with `startTimeMs` (defaults to the live capture clock). Returns the exact
   * timestamp used so the caller can install the transport anchor with the SAME
   * value — otherwise anchor and DSP timestamps diverge (audit F1). Permanent
   * no-op once stopped.
   */
  async activate(startTimeMs?: number): Promise<number> {
    const stamp = startTimeMs ?? this.captureClockMs();
    if (this.stopped || this.phase !== "started" || !this.node || !this.context) return stamp;
    this.epoch += 1;
    this.active = true;
    this.node.port.postMessage({ epoch: this.epoch, startTimeMs: stamp, type: "activate" });
    if (this.context.resume) {
      try {
        await this.context.resume();
      } catch {
        // best-effort
      }
    }
    return stamp;
  }

  /**
   * Stops emission and drains the worklet's partial chunk, resolving only after
   * the worklet acks the flush (bounded by `flushTimeoutMs`). No-op once stopped.
   */
  async deactivateAndFlush(): Promise<void> {
    if (this.stopped || !this.active || !this.node) return;
    this.active = false;
    const epoch = this.epoch;
    this.node.port.postMessage({ epoch, type: "deactivate" });
    await this.awaitFlush(epoch);
  }

  private awaitFlush(epoch: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const startedAtMs = this.captureClockMs();
      let handle: unknown;
      const checkTimeout = () => {
        if (this.pendingFlush && this.pendingFlush.epoch === epoch) {
          // A suspended shared context may not process the worklet command.
          // Preserve its tail and anchor until rendering resumes, rather than
          // reporting an interrupted output as a microphone failure.
          const remainingMs = this.flushTimeoutMs - (this.captureClockMs() - startedAtMs);
          if (remainingMs > 0) {
            handle = this.setTimer(checkTimeout, Math.max(250, remainingMs));
            return;
          }
          this.pendingFlush = null;
          this.report(new KaraokeMicError("unknown", "capture flush ack timed out"));
        }
        resolve();
      };
      handle = this.setTimer(checkTimeout, this.flushTimeoutMs);
      this.pendingFlush = {
        epoch,
        resolve: () => {
          this.clearTimer(handle);
          resolve();
        },
      };
    });
  }

  /** PERMANENT teardown: stops tracks, closes the context, makes activate() a no-op. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.active = false;
    this.epoch += 1; // invalidate any in-flight chunk messages
    if (this.pendingFlush) {
      this.pendingFlush.resolve();
      this.pendingFlush = null;
    }
    try {
      this.node?.port.postMessage({ type: "stop" });
    } catch {
      // best-effort
    }
    await this.cleanupGraph();
  }

  /** Tears down the graph (disconnect, stop tracks, close context). Shared by stop() and start()-failure. */
  private async cleanupGraph(): Promise<void> {
    if (this.node) this.node.port.onmessage = null;
    try {
      this.source?.disconnect();
    } catch {
      // best-effort
    }
    try {
      this.node?.disconnect();
    } catch {
      // best-effort
    }
    this.stopTracks();
    try {
      if (this.context) {
        if (this.deps.releaseContext) await this.deps.releaseContext(this.context);
        else await this.context.close();
      }
    } catch {
      // best-effort
    }
    this.context = null;
    this.node = null;
    this.source = null;
    this.stream = null;
  }

  /** A track ending mid-session is a device failure: report AND stop so no further chunks emit (audit F5). */
  private handleTrackEnded(): void {
    if (this.stopped) return;
    this.report(new KaraokeMicError("device_unavailable", "Microphone track ended"));
    void this.stop(); // epoch bumps synchronously → queued chunks dropped immediately
  }

  private handleMessage(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const message = data as { type?: string; epoch?: number; pcm16?: ArrayBuffer; capturedAtMs?: number };
    if (message.type === "chunk") {
      // Drop stale-epoch chunks, anything after stop(), and anything before the
      // first activate() (epoch 0 = inactive sentinel): the engine owns epochs.
      if (this.stopped || this.epoch === 0 || message.epoch !== this.epoch) return;
      if (message.pcm16 && typeof message.capturedAtMs === "number") {
        this.options.onChunk(message.pcm16, message.capturedAtMs);
      }
      return;
    }
    if (message.type === "flushed") {
      if (this.pendingFlush && this.pendingFlush.epoch === message.epoch) {
        const { resolve } = this.pendingFlush;
        this.pendingFlush = null;
        resolve();
      }
    }
  }

  private stopTracks(): void {
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) {
      track.onended = null;
      try {
        track.stop();
      } catch {
        // best-effort
      }
    }
  }

  private captureConstraints(): unknown {
    // Karaoke scoring needs the raw sung vocal. The browser's voice-call DSP is
    // hostile here: echoCancellation removes audio correlated with playback
    // (the instrumental bleed AND the singer's own voice), noiseSuppression
    // strips sustained tones (i.e. singing), and autoGainControl distorts
    // dynamics — together they can hand the STT near-silence and grade every
    // line a miss. Capture raw (headphones recommended to avoid instrumental
    // bleed).
    return { audio: { autoGainControl: false, channelCount: 1, echoCancellation: false, noiseSuppression: false } };
  }

  private report(error: KaraokeMicError): KaraokeMicError {
    this.options.onError?.({ code: error.code, message: error.message });
    return error;
  }
}
