// Browser side of the operator's Karaoke audio socket. The capture anchor,
// audio drop rules, binary framing, shared sequence across reconnects,
// reconnect backoff and serialized suspend/resume follow pirate-web-solid
// 667a6f22 runtime/karaoke-session-client.ts, adapted to the operator's ticket
// socket: "live" means the operator's ready message, the reconnect reuses the
// ticket connection, and control frames are the operator's audio_pause,
// audio_seek and finish. Audio is never replayed after a reconnect.
// See docs/karaoke-capture-handoff.md.
import { encodeKaraokeBinaryFrame } from "./binary-codec.ts";
import type { CaptureAnchorSink } from "./capture-lifecycle.ts";
import { KARAOKE_TRANSPORT_PROTOCOL_VERSION } from "./transport.ts";

export interface KaraokeOperatorSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number }) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
}
export type KaraokeOperatorPhase =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed"
  | "aborted";
export interface KaraokeOperatorReady {
  type: "ready";
  attemptId: string;
  resumed: boolean;
  /** Last sequence accepted by the operator, preserved across page reloads. */
  audioSequence?: number;
  [key: string]: unknown;
}
export interface KaraokeOperatorClientOptions {
  /** Opens the operator's /attempt socket for this ticket (connection proof included). */
  openSocket: () => KaraokeOperatorSocket;
  ticketId: string;
  onPhaseChange?: (phase: KaraokeOperatorPhase) => void;
  onMessage?: (message: Record<string, unknown>) => void;
  onError?: (error: { code: string; message: string }) => void;
  suspendCapture?: () => Promise<void>;
  resumeCapture?: () => Promise<void>;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  maxReconnectDelayMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
}
export interface KaraokeCaptureAnchor {
  captureMs: number;
  songMs: number;
  playbackRate: number;
}

/** The operator closes a socket superseded by the learner's newer connection. */
export const KARAOKE_SUPERSEDED_CLOSE_CODE = 4409;
const SAMPLE_RATE = 16_000;

export class KaraokeOperatorAudioClient implements CaptureAnchorSink {
  private readonly options: KaraokeOperatorClientOptions;
  private phase: KaraokeOperatorPhase = "idle";
  private socket: KaraokeOperatorSocket | null = null;
  private attemptId: string | null = null;
  private anchor: KaraokeCaptureAnchor | null = null;
  private lastCapturedAtMs: number | null = null;
  private sequence = 0;
  private chunkId = 0;
  private everLive = false;
  private reconnectAttempts = 0;
  private reconnectTimer: unknown = null;
  private captureChain: Promise<void> = Promise.resolve();
  private captureGeneration = 0;
  private captureSuspendPending = false;
  private captureSuspendOk = true;
  private feedbackRecovery: object | null = null;

  constructor(options: KaraokeOperatorClientOptions) {
    this.options = options;
  }

  getPhase(): KaraokeOperatorPhase {
    return this.phase;
  }

  start(): void {
    if (this.phase !== "idle") return;
    this.connect();
  }

  setCaptureAnchor(anchor: KaraokeCaptureAnchor): void {
    if (!Number.isFinite(anchor.captureMs))
      throw new RangeError("karaoke anchor captureMs must be finite");
    if (!Number.isFinite(anchor.songMs) || anchor.songMs < 0)
      throw new RangeError(
        "karaoke anchor songMs must be finite and non-negative",
      );
    if (!Number.isFinite(anchor.playbackRate) || anchor.playbackRate <= 0)
      throw new RangeError(
        "karaoke anchor playbackRate must be finite and > 0",
      );
    this.anchor = { ...anchor };
    // New epoch: a legitimate backward-seek re-anchor may regress capture time.
    this.lastCapturedAtMs = null;
  }

  clearCaptureAnchor(): void {
    this.anchor = null;
    this.lastCapturedAtMs = null;
  }

  /** One PCM16 chunk captured at capturedAtMs; dropped unless live and anchored. */
  pushAudio(
    pcm16: ArrayBuffer,
    capturedAtMs: number,
    songRange?: { songStartMs: number; songEndMs: number },
  ): void {
    if (this.phase !== "live" || !this.socket || this.attemptId === null)
      return;
    const anchor = this.anchor;
    if (!anchor || !Number.isFinite(capturedAtMs)) return;
    if (capturedAtMs < anchor.captureMs) return;
    if (this.lastCapturedAtMs !== null && capturedAtMs < this.lastCapturedAtMs)
      return;
    const durationMs = (pcm16.byteLength / 2 / SAMPLE_RATE) * 1000;
    const songEndMs =
      songRange?.songEndMs ??
      anchor.songMs + (capturedAtMs - anchor.captureMs) * anchor.playbackRate;
    if (!Number.isFinite(songEndMs) || songEndMs < 0) return;
    const songStartMs =
      songRange?.songStartMs ??
      Math.max(0, songEndMs - durationMs * anchor.playbackRate);
    this.lastCapturedAtMs = capturedAtMs;
    this.sendBinary(pcm16, Math.round(songStartMs), Math.round(songEndMs));
  }

  pause(songMs: number): void {
    this.sendControl({
      type: "audio_pause",
      songMs: Math.max(0, Math.round(songMs)),
    });
  }
  seek(songMs: number): void {
    this.sendControl({
      type: "audio_seek",
      songMs: Math.max(0, Math.round(songMs)),
    });
  }
  finish(): void {
    this.sendControl({ type: "finish" });
  }
  /** Any other operator frame, such as a segment purchase. */
  send(frame: Record<string, unknown>): void {
    this.sendControl(frame);
  }

  close(): void {
    this.shutdown("closed");
  }

  /** Recover a stalled response on the same ticket, with a finite ready wait. */
  reconnect(): boolean {
    if (this.phase !== "live" || !this.socket) return false;
    const old = this.socket;
    this.socket = null;
    const recovery = {};
    this.feedbackRecovery = recovery;
    const setTimer =
      this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    setTimer(() => {
      if (this.feedbackRecovery !== recovery || this.isTerminal()) return;
      try {
        this.options.onError?.({
          code: "karaoke_recovery_timeout",
          message: "The scoring connection did not recover.",
        });
      } finally {
        this.shutdown("aborted");
      }
    }, 10000);
    try {
      this.requestCaptureSuspension();
      this.scheduleReconnect();
    } finally {
      try {
        old.close(1000, "scoring_reconnect");
      } catch {
        /* Already closed. */
      }
    }
    return true;
  }

  private sendControl(frame: Record<string, unknown>): void {
    if (this.phase !== "live" || !this.socket) return;
    this.socket.send(JSON.stringify(frame));
  }

  private sendBinary(
    pcm16: ArrayBuffer,
    songStartMs: number,
    songEndMs: number,
  ): void {
    if (!this.socket || this.attemptId === null) return;
    if (
      !Number.isInteger(songStartMs) ||
      !Number.isInteger(songEndMs) ||
      songStartMs < 0 ||
      songEndMs > 0xffff_ffff ||
      songStartMs > songEndMs
    ) {
      this.options.onError?.({
        code: "karaoke_audio_bounds_invalid",
        message: `song bounds out of uint32 range: ${songStartMs}..${songEndMs}`,
      });
      return;
    }
    this.chunkId += 1;
    this.sequence += 1;
    this.socket.send(
      encodeKaraokeBinaryFrame({
        protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
        sessionId: this.options.ticketId,
        attemptId: this.attemptId,
        sequence: this.sequence,
        type: "audio_chunk",
        chunkId: this.chunkId,
        pcm16,
        sampleRate: SAMPLE_RATE,
        songStartMs,
        songEndMs,
      }),
    );
  }

  private setPhase(phase: KaraokeOperatorPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhaseChange?.(phase);
  }

  private connect(): void {
    if (this.isTerminal()) return;
    this.setPhase(this.everLive ? "reconnecting" : "connecting");
    let socket: KaraokeOperatorSocket;
    try {
      socket = this.options.openSocket();
    } catch (error) {
      this.options.onError?.({
        code: "karaoke_socket_error",
        message: String(error),
      });
      if (this.everLive) this.scheduleReconnect();
      else this.shutdown("aborted");
      return;
    }
    this.socket = socket;
    let ready = false;
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (
        !ready &&
        message.type === "ready" &&
        typeof message.attemptId === "string"
      ) {
        const cursor =
          message.audioSequence === undefined && message.resumed !== true
            ? 0
            : message.audioSequence;
        if (
          typeof cursor !== "number" ||
          !Number.isSafeInteger(cursor) ||
          cursor < 0 ||
          cursor >= 0xffff_ffff
        ) {
          this.options.onError?.({
            code: "karaoke_audio_cursor_invalid",
            message: "The audio connection could not be resumed.",
          });
          this.shutdown("aborted");
          return;
        }
        ready = true;
        this.feedbackRecovery = null;
        this.attemptId = message.attemptId;
        // A fresh page has no local cursor; an in-memory reconnect may have
        // already sent later frames. Neither case replays previously sent audio.
        this.sequence = Math.max(this.sequence, cursor);
        this.chunkId = Math.max(this.chunkId, this.sequence);
        this.reconnectAttempts = 0;
        const reconnect = this.everLive;
        this.everLive = true;
        this.setPhase("live");
        // A reconnect resumes capture on a fresh anchor; audio is never replayed.
        if (reconnect) this.resumeCaptureAfterReconnect(socket);
      }
      this.options.onMessage?.(message);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (event.code === KARAOKE_SUPERSEDED_CLOSE_CODE) {
        this.requestCaptureSuspension();
        this.options.onError?.({
          code: "karaoke_superseded",
          message: "Karaoke continued in another window",
        });
        this.shutdown("aborted");
        return;
      }
      if (!ready && !this.everLive) {
        this.options.onError?.({
          code: "karaoke_socket_closed_before_open",
          message: `Karaoke connection closed before it opened${event.code ? ` (${event.code})` : ""}`,
        });
        this.shutdown("aborted");
        return;
      }
      this.requestCaptureSuspension();
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.options.onError?.({
        code: "karaoke_socket_error",
        message: "Karaoke connection error",
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.isTerminal()) return;
    const max = this.options.maxReconnectAttempts ?? 5;
    if (this.reconnectAttempts >= max) {
      this.options.onError?.({
        code: "karaoke_reconnect_exhausted",
        message: `Karaoke connection failed after ${max} reconnect attempt${max === 1 ? "" : "s"}`,
      });
      this.shutdown("aborted");
      return;
    }
    const delayMs = Math.min(
      (this.options.reconnectDelayMs ?? 250) * 2 ** this.reconnectAttempts,
      this.options.maxReconnectDelayMs ?? 2_000,
    );
    this.reconnectAttempts += 1;
    this.setPhase("reconnecting");
    const setTimer =
      this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.reconnectTimer = setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private enqueueCaptureTransition(task: () => Promise<void>): Promise<void> {
    const run = this.captureChain.then(task, task);
    this.captureChain = run.catch(() => undefined);
    return run;
  }

  /** Clears the anchor at once and runs one serialized suspend per gap. */
  private requestCaptureSuspension(): void {
    this.clearCaptureAnchor();
    this.captureGeneration += 1;
    if (this.captureSuspendPending || !this.options.suspendCapture) return;
    this.captureSuspendPending = true;
    this.captureSuspendOk = false;
    void this.enqueueCaptureTransition(async () => {
      try {
        await this.options.suspendCapture!();
        this.captureSuspendOk = true;
      } catch (error) {
        this.captureSuspendOk = false;
        this.options.onError?.({
          code: "karaoke_capture_suspend_failed",
          message: String(error),
        });
      } finally {
        this.captureSuspendPending = false;
      }
    });
  }

  private resumeCaptureAfterReconnect(socket: KaraokeOperatorSocket): void {
    const generation = this.captureGeneration;
    void this.enqueueCaptureTransition(async () => {
      if (
        this.socket !== socket ||
        this.phase !== "live" ||
        generation !== this.captureGeneration
      )
        return;
      if (!this.captureSuspendOk) {
        this.options.onError?.({
          code: "karaoke_capture_transition_failed",
          message: "Capture could not be suspended before resuming",
        });
        this.shutdown("aborted");
        return;
      }
      if (!this.options.resumeCapture) return;
      try {
        await this.options.resumeCapture();
        if (
          this.socket !== socket ||
          this.phase !== "live" ||
          generation !== this.captureGeneration
        )
          this.clearCaptureAnchor();
      } catch (error) {
        this.options.onError?.({
          code: "karaoke_capture_resume_failed",
          message: String(error),
        });
        if (this.socket === socket) this.shutdown("aborted");
      }
    });
  }

  private isTerminal(): boolean {
    return this.phase === "closed" || this.phase === "aborted";
  }

  private shutdown(phase: "closed" | "aborted"): void {
    if (this.isTerminal()) return;
    this.clearCaptureAnchor();
    const socket = this.socket;
    this.socket = null;
    this.feedbackRecovery = null;
    try {
      this.setPhase(phase);
    } finally {
      try {
        socket?.close(1000, phase);
      } catch {
        // The socket may already be closing.
      }
    }
  }
}
