// Live microphone audio on the operator's Karaoke socket. Binary frames use the
// adopted centralized binary codec; a relay per take streams them to the
// realtime speech provider and feeds its committed, song-timed words into the
// existing words path before finish and on disconnect. Learners cannot send
// recognized words or failure marks once audio is wired. Text frames other
// than the audio controls go to the existing handler unchanged.
// See docs/karaoke-capture-handoff.md.
import { decodeKaraokeBinaryFrame } from "../packages/karaoke/binary-codec.ts";
import { ElevenLabsKaraokeSttAdapter } from "../packages/karaoke/elevenlabs-realtime.ts";
import {
  KaraokeAudioRelay,
  type KaraokeRelaySnapshot,
} from "../packages/karaoke/audio-relay.ts";
import { check, type Signed, type Ticket } from "../packages/protocol/index.ts";
import {
  RECONNECT_WINDOW_S,
  type KaraokeManifest,
} from "../packages/protocol/payments.ts";
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
        const relay = this.current(ws).relay;
        if (frame.type === "audio_seek") relay.seek(Number(frame.songMs));
        else await relay.pause();
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
