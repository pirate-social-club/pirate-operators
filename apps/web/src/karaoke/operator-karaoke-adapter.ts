import type { KaraokeTimedLine } from "../../../../packages/karaoke/manifest-lines.ts";
import type { KaraokeOperatorResult } from "../api-contract.ts";
import {
  learningRequest,
  LearningServiceError,
  ticketRefusedBeforeReservation,
} from "./operator-learning-http.ts";

export interface KaraokeSong {
  lines: KaraokeTimedLine[];
  segments: { segmentId: string; startMs: number; endMs: number }[];
}
export interface OpenKaraokeTake {
  ticketId: string;
  socketUrl: string;
  proof: string;
}
export interface KaraokeRecord {
  consented: boolean;
  consent: unknown;
  publication: { state: string } | null;
}
export type KaraokeAttemptView =
  | { state: "none" }
  | {
      state: "open";
      ticket: { body: { ticketId: string } };
      socketUrl: string;
      proof: string;
      elapsedMs: number | null;
    }
  | {
      state: "finished";
      result: {
        body: KaraokeOperatorResult & { ticketId: string };
        presentation?: KaraokeOperatorResult["presentation"];
      };
      record: KaraokeRecord;
    };
export interface OperatorKaraokePort {
  playbackUrl(): string | undefined;
  song(): Promise<KaraokeSong>;
  attempt(): Promise<KaraokeAttemptView>;
  ticket(): Promise<OpenKaraokeTake>;
  request<T>(path: string, body: unknown): Promise<T>;
  dispose(): void;
}

/** Adapted from the c7 session bridge's identity-preserving create/reconnect
 * boundary. Operator tickets, proofs and admission replace central sessions.
 * Socket reconnect is owned by KaraokeOperatorAudioClient and reuses this ticket.
 */
export function createOperatorKaraokePort(options: {
  postId: string;
  account: string;
  csrf: () => string;
  request?: <T>(path: string, body?: unknown) => Promise<T>;
}): OperatorKaraokePort {
  const controller = new AbortController();
  let inFlight: Promise<OpenKaraokeTake> | undefined;
  let startUnknown = false;
  let disposed = false;
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    if (disposed) throw new Error("Karaoke was closed.");
    const result = options.request
      ? await options.request<T>(path, body)
      : await learningRequest<T>(path, {
          account: options.account,
          csrf: options.csrf(),
          body,
          signal: controller.signal,
        });
    if (disposed) throw new Error("Karaoke was closed.");
    return result;
  };
  const attempt = () =>
    request<KaraokeAttemptView>(
      `/api/karaoke/attempt?postId=${encodeURIComponent(options.postId)}`,
    );
  const opened = (
    view: Extract<KaraokeAttemptView, { state: "open" }>,
  ): OpenKaraokeTake => ({
    ticketId: view.ticket.body.ticketId,
    socketUrl: view.socketUrl,
    proof: view.proof,
  });
  return {
    playbackUrl: () =>
      `/api/karaoke/posts/${encodeURIComponent(options.postId)}/instrumental`,
    request,
    attempt,
    song: () =>
      request<KaraokeSong>(
        `/api/public/posts/${encodeURIComponent(options.postId)}/karaoke`,
      ),
    ticket() {
      if (inFlight) return inFlight;
      const run = async () => {
        const previous = await attempt();
        if (previous.state === "open") {
          startUnknown = false;
          return opened(previous);
        }
        if (startUnknown)
          throw new Error(
            "We couldn't confirm this take's start. Check the same take again; a new take has not been opened.",
          );
        try {
          const issued = await request<{
            ticket: { body: { ticketId: string } };
            socketUrl: string;
            proof: string;
          }>("/api/karaoke/tickets", { postId: options.postId });
          return {
            ticketId: issued.ticket.body.ticketId,
            socketUrl: issued.socketUrl,
            proof: issued.proof,
          };
        } catch (error) {
          // Require the actual producer's pre-handler refusal, or a transport
          // preflight that never dispatched. Structured409 can follow a wallet
          // reservation commit with lost acknowledgement; status is no proof.
          if (
            error instanceof LearningServiceError &&
            error.evidence?.path === "/api/karaoke/tickets" &&
            error.evidence.method === "POST" &&
            (error.evidence.stage === "before_dispatch" ||
              (error.evidence.stage === "endpoint_refusal" &&
                error.evidence.endpointStatus === error.status &&
                ticketRefusedBeforeReservation(error.status, error.code)))
          )
            throw error;
          startUnknown = true;
          const recovered = await attempt().catch(() => null);
          if (recovered?.state === "open") {
            startUnknown = false;
            return opened(recovered);
          }
          throw new Error(
            "We couldn't confirm this take's start. Check the same take again; a new take has not been opened.",
          );
        }
      };
      inFlight = run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    dispose() {
      disposed = true;
      controller.abort();
    },
  };
}
