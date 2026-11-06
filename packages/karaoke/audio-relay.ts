// Operator-side relay for one Karaoke take: learner audio frames in, the
// realtime provider's committed song-timed words out. The reconnect, buffer,
// commit-ack and seek rules follow api-next a5c63b8 karaoke-runtime
// session-host.ts and session.ts; see docs/karaoke-capture-handoff.md.
import type { KaraokeRecognizedWord } from "../scoring/scoring.ts";
import type {
  KaraokeStreamingSttAdapter,
  KaraokeSttAdapterMessage,
} from "./stt-adapter.ts";
import type { KaraokeClientBinaryFrame } from "./transport.ts";

export const MAX_RECONNECT_ATTEMPTS = 5;
export const RECONNECT_BACKOFF_BASE_MS = 250;
export const RECONNECT_BACKOFF_CAP_MS = 2_000;
export const MAX_RECONNECT_BUFFER_FRAMES = 600;
export const COMMIT_ACK_TIMEOUT_MS = 2_000;
/** A seek drops recognized words ending after this much before the seek point. */
export const SEEK_WORD_TOLERANCE_MS = 300;
export const MAX_RETAINED_WORDS = 2_000;

export const reconnectBackoffMs = (attempt: number) =>
  Math.min(
    RECONNECT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
    RECONNECT_BACKOFF_CAP_MS,
  );

export interface KaraokeRelayLine {
  lineId: string;
  startMs: number;
  endMs: number;
}
export interface KaraokeRelaySnapshot {
  words: KaraokeRecognizedWord[];
  failedLineIds: string[];
  forwardedWords: number;
  forwardedFailedLineIds: string[];
  lastSequence: number | null;
  sttSequence: number;
  terminal: string | null;
}
export interface KaraokeAudioRelayOptions {
  sessionId: string;
  attemptId: string;
  lines: readonly KaraokeRelayLine[];
  /** Null when the operator has no provider credential: a known failure. */
  createAdapter: (() => KaraokeStreamingSttAdapter) | null;
  restore?: KaraokeRelaySnapshot;
  persist?: (snapshot: KaraokeRelaySnapshot) => void;
  delay?: (ms: number) => Promise<void>;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}
export class KaraokeAudioError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

interface PendingCommit {
  commitId: string;
  streamGeneration: string;
  frontierMs: number;
  timer: unknown;
  settled: () => void;
}

export class KaraokeAudioRelay {
  private readonly options: KaraokeAudioRelayOptions;
  private readonly lines: KaraokeRelayLine[];
  private adapter: KaraokeStreamingSttAdapter | null = null;
  private starting: Promise<boolean> | null = null;
  private pendingDone: Promise<void> = Promise.resolve();
  private reconnecting = false;
  private buffer: KaraokeClientBinaryFrame[] = [];
  private pending: PendingCommit | null = null;
  private requesting: Promise<boolean> | null = null;
  private readonly droppedCommits = new Set<string>();
  private coveredMs = 0;
  private submittedMs = 0;
  private closed = false;
  private state: KaraokeRelaySnapshot;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: KaraokeAudioRelayOptions) {
    this.options = options;
    this.lines = [...options.lines].sort((a, b) => a.endMs - b.endMs);
    this.state = structuredClone(
      options.restore ?? {
        words: [],
        failedLineIds: [],
        forwardedWords: 0,
        forwardedFailedLineIds: [],
        lastSequence: null,
        sttSequence: 0,
        terminal: null,
      },
    );
    this.setTimer =
      options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.delay =
      options.delay ??
      ((ms) => new Promise((resolve) => this.setTimer(() => resolve(), ms)));
  }

  get terminal(): string | null {
    return this.state.terminal;
  }

  /** One learner audio frame, in sequence order across reconnects. */
  async audio(frame: KaraokeClientBinaryFrame): Promise<void> {
    if (
      this.state.lastSequence !== null &&
      frame.sequence <= this.state.lastSequence
    )
      throw new KaraokeAudioError("sequence_out_of_order");
    this.state.lastSequence = frame.sequence;
    if (this.closed || this.state.terminal !== null) return this.save();
    this.submittedMs = Math.max(this.submittedMs, frame.songEndMs);
    if (this.reconnecting) {
      // Buffered, not dropped, while the provider stream reconnects; oldest
      // frames go first on overflow (a small leading audio gap).
      this.buffer.push(frame);
      if (this.buffer.length > MAX_RECONNECT_BUFFER_FRAMES) this.buffer.shift();
      return this.save();
    }
    await this.ensureStarted();
    if (this.adapter === null || this.state.terminal !== null)
      return this.save();
    await this.adapter.sendPcm16(frame);
    await this.requestCommitIfDue();
    this.save();
  }

  /** The learner paused; commit what has been heard so far. */
  async pause(): Promise<void> {
    if (this.adapter !== null && !this.reconnecting) await this.requestCommit();
  }

  /** A seek invalidates later words and any commit reaching past the seek point. */
  seek(songMs: number): void {
    if (!Number.isFinite(songMs) || songMs < 0)
      throw new KaraokeAudioError("invalid_seek");
    const keepUntil = songMs - SEEK_WORD_TOLERANCE_MS;
    const kept = (word: KaraokeRecognizedWord) => word.endMs <= keepUntil;
    // Forwarded words follow the same rule: the operator drops them from the
    // take too, so only words still counted stay within the retained limit.
    const forwarded = this.state.words
      .slice(0, this.state.forwardedWords)
      .filter(kept);
    const retained = this.state.words
      .slice(this.state.forwardedWords)
      .filter(kept);
    this.state.words = [...forwarded, ...retained];
    this.state.forwardedWords = forwarded.length;
    const reopened = new Set(
      this.lines.filter((l) => l.endMs > songMs).map((l) => l.lineId),
    );
    this.state.failedLineIds = this.state.failedLineIds.filter(
      (id) =>
        !reopened.has(id) || this.state.forwardedFailedLineIds.includes(id),
    );
    if (this.pending !== null && this.pending.frontierMs > songMs) {
      this.droppedCommits.add(this.pending.commitId);
      this.settlePending();
    }
    this.coveredMs = Math.min(this.coveredMs, songMs);
    this.submittedMs = songMs;
    this.save();
  }

  /** Commits the remaining audio, waits for it and closes the provider stream. */
  async finish(): Promise<void> {
    if (this.adapter !== null && this.state.terminal === null) {
      // Settle every commit in flight first, including one an acknowledgement
      // has just started: the adapter has one commit slot, and a refused final
      // commit would mark audio it is still measuring as unmeasured.
      for (
        let i = 0;
        i < 16 && (this.requesting !== null || this.pending !== null);
        i++
      ) {
        if (this.requesting !== null) await this.requesting.catch(() => false);
        else await this.waitForPending();
      }
      const committed = await this.requestCommit();
      if (committed) await this.waitForPending();
      else this.failRange(this.coveredMs, this.submittedMs, true);
    }
    await this.close();
  }

  /** True when words or failure marks have arrived since the last drain. */
  hasUndrained(): boolean {
    return (
      this.state.words.length > this.state.forwardedWords ||
      this.state.failedLineIds.some(
        (id) => !this.state.forwardedFailedLineIds.includes(id),
      )
    );
  }

  drain(): { words: KaraokeRecognizedWord[]; failedLineIds: string[] } {
    const words = this.state.words.slice(this.state.forwardedWords);
    const failedLineIds = this.state.failedLineIds.filter(
      (id) => !this.state.forwardedFailedLineIds.includes(id),
    );
    this.state.forwardedWords = this.state.words.length;
    this.state.forwardedFailedLineIds.push(...failedLineIds);
    this.save();
    return { words, failedLineIds };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.settlePending();
    const adapter = this.adapter;
    this.adapter = null;
    await adapter?.close().catch(() => undefined);
    this.save();
  }

  private ensureStarted(): Promise<boolean> {
    if (this.adapter !== null) return Promise.resolve(true);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<boolean> {
    if (this.options.createAdapter === null) {
      this.abort("speech_not_configured");
      return false;
    }
    const adapter = this.options.createAdapter();
    try {
      await adapter.start({
        sessionId: this.options.sessionId,
        attemptId: this.options.attemptId,
        initialSequence: this.state.sttSequence,
        onMessage: (message) => this.onProviderMessage(adapter, message),
        onUnexpectedClose: () => void this.reconnect(),
        onTerminalError: (code) => this.abort(`stt_${code}`),
      });
    } catch {
      await adapter.close().catch(() => undefined);
      return false;
    }
    if (this.closed) {
      await adapter.close().catch(() => undefined);
      return false;
    }
    this.adapter = adapter;
    return true;
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closed || this.state.terminal !== null)
      return;
    this.reconnecting = true;
    this.adapter = null;
    try {
      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
        await this.delay(reconnectBackoffMs(attempt));
        if (this.closed || this.state.terminal !== null) return;
        if (await this.start()) {
          const fresh = this.adapter as KaraokeStreamingSttAdapter | null;
          // The dead stream's commit can never be acknowledged by the new one.
          const pending = this.pending as PendingCommit | null;
          if (
            pending !== null &&
            pending.streamGeneration !== fresh?.streamGeneration
          )
            this.orphanPending();
          while (this.buffer.length > 0 && fresh !== null) {
            const frame = this.buffer.shift()!;
            await fresh.sendPcm16(frame);
          }
          await this.requestCommitIfDue();
          return;
        }
      }
      this.abort("stt_reconnect_failed");
    } finally {
      this.reconnecting = false;
      this.buffer = [];
      this.save();
    }
  }

  private async onProviderMessage(
    adapter: KaraokeStreamingSttAdapter,
    message: KaraokeSttAdapterMessage,
  ): Promise<void> {
    this.state.sttSequence = Math.max(
      this.state.sttSequence,
      message.event.sequence,
    );
    if (message.event.type !== "stt_final") return this.save();
    if (message.commit && this.droppedCommits.has(message.commit.commitId))
      return this.save();
    const room = MAX_RETAINED_WORDS - this.state.words.length;
    this.state.words.push(...message.event.words.slice(0, Math.max(0, room)));
    const pending = this.pending;
    if (
      message.commit &&
      pending !== null &&
      message.commit.commitId === pending.commitId &&
      message.commit.streamGeneration === adapter.streamGeneration
    ) {
      this.coveredMs = Math.max(this.coveredMs, pending.frontierMs);
      this.settlePending();
      await this.requestCommitIfDue();
    }
    this.save();
  }

  private async requestCommitIfDue(): Promise<void> {
    const due = this.lines.some(
      (line) => line.endMs <= this.submittedMs && line.endMs > this.coveredMs,
    );
    if (due) await this.requestCommit();
  }

  /** One commit request at a time; a concurrent caller shares its outcome. */
  private requestCommit(): Promise<boolean> {
    if (this.requesting !== null) return this.requesting;
    const request = this.issueCommit();
    this.requesting = request;
    const clear = () => {
      if (this.requesting === request) this.requesting = null;
    };
    request.then(clear, clear);
    return request;
  }

  private async issueCommit(): Promise<boolean> {
    if (this.adapter === null || this.pending !== null)
      return this.pending !== null;
    const handle = await this.adapter.commit();
    if (handle === null) return false;
    let settled!: () => void;
    const done = new Promise<void>((resolve) => (settled = resolve));
    const pending: PendingCommit = {
      ...handle,
      settled,
      timer: this.setTimer(() => {
        if (this.pending === pending) this.orphanPending();
      }, COMMIT_ACK_TIMEOUT_MS),
    };
    this.pending = pending;
    this.pendingDone = done;
    return true;
  }

  private waitForPending(): Promise<void> {
    return this.pending === null ? Promise.resolve() : this.pendingDone;
  }

  /** A commit that will never be acknowledged: its audio was not measured. */
  private orphanPending(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.droppedCommits.add(pending.commitId);
    this.failRange(this.coveredMs, pending.frontierMs, false);
    this.coveredMs = Math.max(this.coveredMs, pending.frontierMs);
    this.settlePending();
    this.save();
  }

  private settlePending(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.clearTimer(pending.timer);
    pending.settled();
  }

  /** Lines overlapping (fromMs, toMs] were not measured by the provider. */
  private failRange(fromMs: number, toMs: number, endedOnly: boolean): void {
    for (const line of this.lines) {
      const overlaps = endedOnly
        ? line.endMs > fromMs && line.endMs <= toMs
        : line.endMs > fromMs && line.startMs < toMs;
      if (overlaps && !this.state.failedLineIds.includes(line.lineId))
        this.state.failedLineIds.push(line.lineId);
    }
  }

  private abort(code: string): void {
    if (this.state.terminal !== null) return;
    this.state.terminal = code;
    // Everything not already measured is unmeasured, never a wrong answer.
    this.failRange(this.coveredMs, Number.POSITIVE_INFINITY, false);
    this.settlePending();
    const adapter = this.adapter;
    this.adapter = null;
    void adapter?.close().catch(() => undefined);
    this.save();
  }

  private save(): void {
    this.options.persist?.(structuredClone(this.state));
  }
}
