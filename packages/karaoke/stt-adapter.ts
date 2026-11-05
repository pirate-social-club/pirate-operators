// Independently adopted from api-next a5c63b8 packages/application/src/karaoke-runtime/session-host.ts lines 21-77: the streaming speech adapter contract, unchanged.
import type { KaraokeClientBinaryFrame, KaraokeStreamingSttEvent } from "./transport.ts";

/** Correlation metadata attached to a committed final (never relayed to clients). */
export interface KaraokeSttCommitAck {
  commitId: string;
  streamGeneration: string;
  coverageMs: number;
}

/**
 * Internal adapter → host message. `event` is the client-relayable transcript;
 * `commit` (present only on committed finals) carries the correlation metadata
 * the host uses for the watermark/second-gate. Keeping commit metadata off the
 * transport event guarantees it never leaks to clients.
 */
export interface KaraokeSttAdapterMessage {
  event: KaraokeStreamingSttEvent;
  commit?: KaraokeSttCommitAck | undefined;
}

export interface KaraokeStreamingSttAdapter {
  /** Opaque id for the current provider stream; null before start()/after close(). */
  readonly streamGeneration: string | null;
  start(input: {
    attemptId: string;
    sessionId: string;
    /**
     * Sequence the adapter's STT envelope counter must resume FROM: the first
     * event it emits is `initialSequence + 1`. The host rejects non-monotonic STT
     * sequences and does not advance `lastSttSequence` on rejection, so an adapter
     * that restarts its counter at 0 has every event refused until it climbs back
     * past the pre-restart high-water mark. Both restart paths (same-host provider
     * reconnect, fresh-DO restore) MUST pass the host's surviving counter.
     */
    initialSequence: number;
    onMessage: (message: KaraokeSttAdapterMessage) => Promise<void>;
    /**
     * Fired when the provider stream drops unexpectedly (network close/error, or
     * a transient provider error the adapter treats as a drop), NOT on intentional
     * close() or a terminal provider error. The host uses this to drive reconnect.
     */
    onUnexpectedClose?: () => void;
    /**
     * Fired on a TERMINAL provider error (auth/quota/input/time-limit) that a
     * reconnect cannot fix. The host aborts the session visibly so the user sees a
     * real error rather than silent, un-scored lines. Absent on adapters that
     * cannot distinguish terminal errors.
     */
    onTerminalError?: (code: string) => void;
  }): Promise<void>;
  sendPcm16(frame: KaraokeClientBinaryFrame): Promise<void>;
  /**
   * Request an explicit commit of audio submitted so far. Returns the commit's
   * correlation handle, or null when refused (below the provider audio floor or a
   * commit is already in flight). Refusal must NOT tear down the stream.
   */
  commit(): Promise<{ commitId: string; streamGeneration: string; frontierMs: number } | null>;
  close(): Promise<void>;
}
