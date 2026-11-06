// Live microphone audio on the operator's Karaoke socket. Binary frames use the
// adopted centralized binary codec; a relay per take streams them to the
// realtime speech provider and feeds its committed, song-timed words into the
// existing words path as they arrive, before finish and on disconnect. Words
// sung before the performance ended still count if they arrive after the
// operator's timer ended it, until the payment deadline. Learners cannot send
// recognized words or failure marks once audio is wired. Text frames other
// than the audio controls go to the existing handler unchanged.
// See docs/karaoke-capture-handoff.md.
import { decodeKaraokeBinaryFrame } from "../packages/karaoke/binary-codec.ts";
import { ElevenLabsKaraokeSttAdapter } from "../packages/karaoke/elevenlabs-realtime.ts";
import {
  KaraokeAudioRelay,
  SEEK_WORD_TOLERANCE_MS,
  type KaraokeRelaySnapshot,
} from "../packages/karaoke/audio-relay.ts";
import { check, type Signed, type Ticket } from "../packages/protocol/index.ts";
import {
  RECONNECT_WINDOW_S,
  type KaraokeManifest,
} from "../packages/protocol/payments.ts";
import type { KaraokeRecognizedWord } from "../packages/scoring/scoring.ts";
import { onMessage } from "./karaoke.ts";
import type { Attempt } from "./karaoke-result.ts";
import { ServiceState, type Env } from "./runtime.ts";

export interface KaraokeAudioEnv extends Env {
  /** Pirate's realtime speech credential; absent means speech is not configured. */
  ELEVENLABS_API_KEY?: string;
}

const LEARNER_FORBIDDEN = new Set(["words", "provider_failed"]);
const BATCH = 100;

export class KaraokeAudioState extends ServiceState {
  private readonly relays = new Map<string, KaraokeAudioRelay>();
  private readonly idle = new Map<string, ReturnType<typeof setTimeout>>();

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ) {
    try {
      if (typeof message !== "string") return await this.audio(ws, message);
      check(message.length <= 32000, "invalid_frame");
      const frame = JSON.parse(message) as { type?: unknown; songMs?: unknown };
      check(
        !LEARNER_FORBIDDEN.has(String(frame?.type)),
        "operator_transcription_only",
      );
      if (frame.type === "audio_pause" || frame.type === "audio_seek") {
        const { ticketId, attempt, relay } = this.current(ws);
        if (frame.type === "audio_seek") {
          const songMs = Number(frame.songMs);
          relay.seek(songMs);
          this.reopen(ticketId, attempt, songMs);
        } else await relay.pause();
        return;
      }
      if (frame.type === "finish") {
        const { ticketId } = this.attachment(ws);
        const relay = ticketId ? this.relays.get(ticketId) : undefined;
        if (ticketId && relay) {
          await relay.finish();
          await this.forward(ws, relay);
          this.relays.delete(ticketId);
        }
      }
      return await super.webSocketMessage(ws, message);
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: error instanceof Error ? error.message : "protocol_error",
        }),
      );
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const { ticketId, generation } = this.attachment(ws);
    const relay = ticketId ? this.relays.get(ticketId) : undefined;
    const attempt = ticketId
      ? this.store.get<Attempt>(`attempt:${ticketId}`)
      : undefined;
    if (relay && attempt?.generation === generation) {
      // Words heard so far reach the scorer even if the learner never returns.
      await this.forward(ws, relay).catch(() => undefined);
      this.idle.set(
        ticketId!,
        setTimeout(
          () => {
            this.idle.delete(ticketId!);
            if (this.relays.get(ticketId!) === relay)
              this.relays.delete(ticketId!);
            void relay.close();
          },
          (RECONNECT_WINDOW_S + 5) * 1000,
        ),
      );
    }
    super.webSocketClose(ws, code, reason);
  }

  private async audio(ws: WebSocket, data: ArrayBuffer) {
    const { ticketId, attempt, relay } = this.current(ws);
    const decoded = decodeKaraokeBinaryFrame(data, {
      sessionId: ticketId,
      attemptId: attempt.attemptId,
    });
    if (decoded.error) throw new Error(decoded.error.code);
    await relay.audio(decoded.frame);
    // Words reach the scorer as each line's transcript arrives, so the
    // operator's song-end timer never strands them in the relay.
    if (relay.hasUndrained()) await this.forward(ws, relay);
  }

  /**
   * Words are handed to the scorer as they arrive, so a seek applies the
   * relay's own rule to them too: words ending after the seek point less the
   * tolerance are dropped, and failure marks of the replayed lines reopen.
   */
  private reopen(ticketId: string, attempt: Attempt, songMs: number) {
    const keepUntil = songMs - SEEK_WORD_TOLERANCE_MS,
      key = `words:${ticketId}`,
      words = this.store.get<KaraokeRecognizedWord[]>(key) ?? [];
    this.store.set(
      key,
      words.filter((w) => w.endMs <= keepUntil),
    );
    const ticket = this.store.get<Signed<Ticket>>(`ticket:${ticketId}`)?.body,
      manifest =
        ticket &&
        this.store.get<KaraokeManifest>(`manifest:${ticket.manifestSha256}`),
      reopened = new Set(
        (manifest?.lines ?? [])
          .filter((l) => l.endMs > songMs)
          .map((l) => l.lineId),
      );
    attempt.failedLineIds = attempt.failedLineIds.filter(
      (id) => !reopened.has(id),
    );
    this.store.set(`attempt:${ticketId}`, attempt);
  }

  private attachment(ws: WebSocket) {
    return (ws.deserializeAttachment() ?? {}) as {
      ticketId?: string;
      generation?: number;
    };
  }

  /** The live take behind this socket, with its relay; stale sockets are refused. */
  private current(ws: WebSocket) {
    const { ticketId, generation } = this.attachment(ws);
    const attempt = ticketId
      ? this.store.get<Attempt>(`attempt:${ticketId}`)
      : undefined;
    check(
      ticketId && attempt && attempt.generation === generation,
      "stale_connection",
    );
    check(!attempt.ended, "attempt_closed");
    clearTimeout(this.idle.get(ticketId));
    this.idle.delete(ticketId);
    let relay = this.relays.get(ticketId);
    if (!relay) {
      const ticket = this.store.get<Signed<Ticket>>(`ticket:${ticketId}`)?.body;
      const manifest =
        ticket &&
        this.store.get<KaraokeManifest>(`manifest:${ticket.manifestSha256}`);
      check(manifest, "protocol_error");
      const key = `audioRelay:${ticketId}`;
      const apiKey = (this.env as KaraokeAudioEnv).ELEVENLABS_API_KEY;
      relay = new KaraokeAudioRelay({
        sessionId: ticketId,
        attemptId: attempt.attemptId,
        lines: manifest.lines.map(({ lineId, startMs, endMs }) => ({
          lineId,
          startMs,
          endMs,
        })),
        createAdapter: apiKey
          ? () => new ElevenLabsKaraokeSttAdapter({ apiKey })
          : null,
        restore: this.store.get<KaraokeRelaySnapshot>(key),
        persist: (snapshot) => this.store.set(key, snapshot),
      });
      this.relays.set(ticketId, relay);
    }
    return { ticketId, attempt, relay };
  }

  /** Hands relay output to the existing words path and scorer, in bounded batches. */
  private async forward(ws: WebSocket, relay: KaraokeAudioRelay) {
    const { words, failedLineIds } = relay.drain();
    if (words.length === 0 && failedLineIds.length === 0) return;
    const { ticketId } = this.attachment(ws),
      attempt = ticketId
        ? this.store.get<Attempt>(`attempt:${ticketId}`)
        : undefined;
    if (ticketId && attempt?.ended && !attempt.closing) {
      // The timer ended the performance first. What was sung before its end
      // is still the learner's take, until the payment deadline closes it.
      const cutoffMs =
          (attempt.ended.performanceEndedAt - attempt.startedAt) * 1000,
        stored =
          this.store.get<KaraokeRecognizedWord[]>(`words:${ticketId}`) ?? [],
        late = words.filter(
          (w) =>
            typeof w.text === "string" &&
            Number.isFinite(w.startMs) &&
            Number.isFinite(w.endMs) &&
            w.startMs >= 0 &&
            w.endMs >= w.startMs &&
            w.startMs < cutoffMs,
        );
      this.store.set(`words:${ticketId}`, [...stored, ...late].slice(0, 2000));
      attempt.failedLineIds = [
        ...new Set([...attempt.failedLineIds, ...failedLineIds]),
      ];
      this.store.set(`attempt:${ticketId}`, attempt);
      return;
    }
    for (let i = 0; i < words.length; i += BATCH)
      await onMessage(
        ws,
        { type: "words", words: words.slice(i, i + BATCH) },
        this.env,
        this.store,
      );
    for (let i = 0; i < failedLineIds.length; i += BATCH)
      await onMessage(
        ws,
        { type: "provider_failed", lineIds: failedLineIds.slice(i, i + BATCH) },
        this.env,
        this.store,
      );
  }
}
