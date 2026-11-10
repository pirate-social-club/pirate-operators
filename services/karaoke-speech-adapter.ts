import { check, digest } from "../packages/protocol/index.ts";
import {
  ElevenLabsKaraokeSttAdapter,
  KaraokeTokenRefusal,
  type KaraokeSttSocketConnect,
} from "../packages/karaoke/elevenlabs-realtime.ts";
import type { ResultStore } from "./learning-transactions.ts";
import {
  reserveCommunitySpeech,
  type SpeechAdmissionEnv,
} from "./study-speech-reservation.ts";

export interface KaraokeSpeechDispatch {
  requestId: string;
  ordinal: number;
  learnerGeneration: number;
  outcome: "allocating" | "succeeded" | "refused" | "unknown";
  evidence?: Record<string, unknown>;
}

/** Production relay factory, also usable by focused tests with a simulated
 * provider transport. Each physical provider start is allocated durably before
 * admission I/O; learner socket generation is correlation, never dispatch ID. */
export function admittedKaraokeAdapter(options: {
  env: SpeechAdmissionEnv;
  store: Pick<ResultStore, "get" | "set" | "transaction">;
  ticketId: string;
  learnerGeneration: number;
  apiKey: string;
  admissionRequired: boolean;
  connect?: KaraokeSttSocketConnect;
}) {
  const adapter = new ElevenLabsKaraokeSttAdapter({
    apiKey: options.apiKey,
    connect: options.connect,
  });
  if (!options.admissionRequired) return adapter;
  const start = adapter.start.bind(adapter);
  adapter.start = async (input) => {
    const dispatch = options.store.transaction(() => {
      const key = `karaokeSpeechSequence:${options.ticketId}`;
      const ordinal = (options.store.get<number>(key) ?? 0) + 1;
      check(
        Number.isSafeInteger(ordinal) && ordinal > 0,
        "karaoke_speech_sequence_exhausted",
      );
      options.store.set(key, ordinal);
      const value: KaraokeSpeechDispatch = {
        requestId: `karaoke:${options.ticketId}:stream:${ordinal}`,
        ordinal,
        learnerGeneration: options.learnerGeneration,
        outcome: "allocating",
      };
      options.store.set(`karaokeSpeechDispatch:${value.requestId}`, value);
      return value;
    });
    const reservation = await reserveCommunitySpeech(
      options.env,
      "website-karaoke",
      dispatch.requestId,
      digest({
        ticketId: options.ticketId,
        ordinal: dispatch.ordinal,
        generation: options.learnerGeneration,
      }),
    );
    const resolve = async (
      outcome: "succeeded" | "refused" | "unknown",
      evidence: Record<string, unknown>,
    ) => {
      // Preserve structured refusal evidence even if the budget acknowledgement
      // is lost. No token, provider body, credential or audio is stored here.
      options.store.set(`karaokeSpeechDispatch:${dispatch.requestId}`, {
        ...dispatch,
        outcome,
        evidence,
      });
      await reservation.resolve(outcome, evidence).catch(() => undefined);
    };
    try {
      await start(input);
    } catch (error) {
      if (error instanceof KaraokeTokenRefusal) {
        await resolve("refused", {
          ...error.evidence,
          requestId: dispatch.requestId,
        });
      } else {
        await resolve("unknown", {
          schema: "pirate.karaoke-stream-start/1",
          requestId: dispatch.requestId,
          outcome: "uncertain",
        });
      }
      throw error;
    }
    await resolve("succeeded", {
      schema: "pirate.karaoke-stream-start/1",
      requestId: dispatch.requestId,
      outcome: "started",
    });
  };
  return adapter;
}
