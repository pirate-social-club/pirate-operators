// Live microphone audio on the operator's Karaoke socket. Binary frames use the
// adopted centralized binary codec; a relay per take streams them to the
// realtime speech provider. Whenever the relay persists new committed,
// song-timed words, they are stored as the take's recognized words, whichever
// of the learner's sockets carried the audio, after the take's timers apply.
// Words sung before the performance ended still count if they arrive after the
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
import type { Attempt } from "./karaoke-result.ts";
import { settle } from "./karaoke.ts";
import { ServiceState, type Env } from "./runtime.ts";

export interface KaraokeAudioEnv extends Env {
  /** Pirate's realtime speech credential; absent means speech is not configured. */
  ELEVENLABS_API_KEY?: string;
}

const LEARNER_FORBIDDEN = new Set(["words", "provider_failed"]);
/** The words path's limit per take (services/karaoke.ts). */
const MAX_WORDS = 2000;

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
        const { ticketId, relay } = this.current(ws);
        if (frame.type === "audio_seek") {
          const songMs = Number(frame.songMs);
          relay.seek(songMs);
          this.reopen(ticketId, songMs);
        } else await relay.pause();
        return;
      }
      if (frame.type === "finish") {
        const { ticketId, generation } = this.attachment(ws);
        const attempt = ticketId
          ? this.store.get<Attempt>(`attempt:${ticketId}`)
          : undefined;
        // Only the live socket finishes the take; a superseded one cannot
        // tear down the relay its replacement is using.
        if (ticketId && attempt?.generation === generation) {
          const relay = this.relays.get(ticketId);
          if (relay) {
            await relay.finish();
            this.forward(ticketId, relay);
            this.relays.delete(ticketId);
          } else this.forwardStored(ticketId);
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
    if (ticketId && attempt?.generation === generation) {
      // Words heard so far reach the scorer even if the learner never returns.
      if (!relay) this.forwardStored(ticketId);
      else {
        this.forward(ticketId, relay);
        this.idle.set(
          ticketId,
          setTimeout(
            () => {
              this.idle.delete(ticketId);
              if (this.relays.get(ticketId) === relay)
                this.relays.delete(ticketId);
              // Finishing commits the audio sent before the socket closed and
              // settles what is pending; what it yields still counts.
              void relay
                .finish()
                .catch(() => relay.close())
                .then(() => this.forward(ticketId, relay));
            },
            (RECONNECT_WINDOW_S + 5) * 1000,
          ),
        );
      }
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
  }

  /**
   * Words are handed to the scorer as they arrive, so a seek applies the
   * relay's own word rule to the stored words too: words ending after the seek
   * point less the tolerance are dropped. Failure marks already handed over
   * stay, as the relay keeps them: a line the relay gave up on, or can no
   * longer measure, must stay unmeasured rather than become silent.
   */
  private reopen(ticketId: string, songMs: number) {
    const keepUntil = songMs - SEEK_WORD_TOLERANCE_MS,
      key = `words:${ticketId}`,
      words = this.store.get<KaraokeRecognizedWord[]>(key) ?? [];
    this.store.set(
      key,
      words.filter((w) => w.endMs <= keepUntil),
    );
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
    // A timer that is due ends the take before audio or a seek can change it.
    const attempt = ticketId
      ? settle(this.store, this.env, ticketId)
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
      relay = this.relayFor(ticketId, attempt, true);
      check(relay, "protocol_error");
      this.relays.set(ticketId, relay);
    }
    return { ticketId, attempt, relay };
  }

  /**
   * The take's relay, restored from its snapshot. Every change it persists
   * hands new words over at once, so words that arrive after the learner's
   * last frame, or after the socket closed, never wait for another event.
   */
  private relayFor(ticketId: string, attempt: Attempt, live: boolean) {
    const ticket = this.store.get<Signed<Ticket>>(`ticket:${ticketId}`)?.body;
    const manifest =
      ticket &&
      this.store.get<KaraokeManifest>(`manifest:${ticket.manifestSha256}`);
    if (!manifest) return undefined;
    const key = `audioRelay:${ticketId}`;
    const apiKey = (this.env as KaraokeAudioEnv).ELEVENLABS_API_KEY;
    let queued = false;
    const relay: KaraokeAudioRelay = new KaraokeAudioRelay({
      sessionId: ticketId,
      attemptId: attempt.attemptId,
      lines: manifest.lines.map(({ lineId, startMs, endMs }) => ({
        lineId,
        startMs,
        endMs,
      })),
      createAdapter:
        live && apiKey
          ? () => {
              const adapter = new ElevenLabsKaraokeSttAdapter({ apiKey });
              if (this.env.OPERATOR_PROFILE === "pirate-karaoke-testnet-v2") {
                const start = adapter.start.bind(adapter);
                adapter.start = async (input) => {
                  check(this.env.SPEECH_BUDGET, "speech_budget_unconfigured");
                  await this.env.SPEECH_BUDGET.getByName("elevenlabs-service").claim();
                  await start(input);
                };
              }
              return adapter;
            }
          : null,
      restore: this.store.get<KaraokeRelaySnapshot>(key),
      persist: (snapshot) => {
        this.store.set(key, snapshot);
        if (!live || queued) return;
        // After the relay's own state change completes, not inside it.
        queued = true;
        queueMicrotask(() => {
          queued = false;
          try {
            this.forward(ticketId, relay);
          } catch {
            // Nothing was drained; the next persisted change hands it over.
          }
        });
      },
    });
    return relay;
  }

  /**
   * After a restart there is no relay in memory; its snapshot's words still
   * count. This restored relay is only drained, never given audio.
   */
  private forwardStored(ticketId: string) {
    const attempt = this.store.get<Attempt>(`attempt:${ticketId}`);
    const relay = attempt && this.relayFor(ticketId, attempt, false);
    if (relay) this.forward(ticketId, relay);
  }

  /**
   * Hands relay output to the take's stored words with the existing words
   * checks. The relay belongs to the ticket, not to a socket, so no reconnect
   * can refuse a hand-over after the relay has drained. The take's timers are
   * applied first, as the words path does. Settling, draining and storing run
   * with no await between them. A take that has ended keeps what was sung
   * before its performance ended, and nothing changes once the payment
   * deadline closes it.
   */
  private forward(ticketId: string, relay: KaraokeAudioRelay) {
    if (!relay.hasUndrained()) return;
    const attempt = settle(this.store, this.env, ticketId);
    if (!attempt || attempt.closing) return;
    const { words, failedLineIds } = relay.drain(),
      cutoffMs = attempt.ended
        ? (attempt.ended.performanceEndedAt - attempt.startedAt) * 1000
        : Number.POSITIVE_INFINITY,
      key = `words:${ticketId}`,
      accepted = words.filter(
        (w) =>
          typeof w.text === "string" &&
          Number.isFinite(w.startMs) &&
          Number.isFinite(w.endMs) &&
          w.startMs >= 0 &&
          w.endMs >= w.startMs &&
          w.startMs < cutoffMs,
      );
    if (accepted.length > 0) {
      const stored = this.store.get<KaraokeRecognizedWord[]>(key) ?? [];
      this.store.set(key, [...stored, ...accepted].slice(0, MAX_WORDS));
      // Words that return after a disconnect were heard before it.
      if (!attempt.ended)
        attempt.lastAudioAt = attempt.disconnectedAt ?? this.store.now();
    }
    attempt.failedLineIds = [
      ...new Set([...attempt.failedLineIds, ...failedLineIds]),
    ];
    this.store.set(`attempt:${ticketId}`, attempt);
  }
}
