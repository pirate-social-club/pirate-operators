import type { Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  StudySpeechError,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";
import type {
  StudySpeechParameters,
  StudySpeechReceipt,
} from "../packages/study/operator-contract.ts";
import type { ResultStore } from "./learning-transactions.ts";
import { closedStudyPublication } from "./study-private-publication.ts";
import {
  reserveCommunitySpeech,
  type SpeechAdmissionEnv,
} from "./study-speech-reservation.ts";
import { completeStudySpeech } from "./study-speech-receipt.ts";

/** Called only after the authenticated binding, slot and pending job exist. */
export async function dispatchStudySpeech(options: {
  env: SpeechAdmissionEnv;
  store: ResultStore;
  parameters: StudySpeechParameters;
  key: string;
  requestHash: Hex;
  bodyHash: Hex;
  expiresAtMs: number;
  channel: "website-study" | "telegram-linked";
  audio: Uint8Array;
  contentType: string;
  language: string;
  provider: StudyTranscriber;
}): Promise<StudySpeechReceipt> {
  const { store, parameters } = options;
  let receipt: StudySpeechReceipt;
  let dispatched = false;
  let reservation:
    | Awaited<ReturnType<typeof reserveCommunitySpeech>>
    | undefined;
  try {
    reservation = await reserveCommunitySpeech(
      options.env,
      options.channel,
      `study:${parameters.attemptId}`,
      options.bodyHash,
    );
    check(
      !closedStudyPublication(store, parameters.lessonId) &&
        store.now() * 1000 < options.expiresAtMs,
      "study_lesson_expired",
    );
    dispatched = true;
    const transcript = await options.provider.transcribe(
      options.audio,
      options.contentType,
      options.language,
    );
    receipt = { state: "assessed", transcript };
  } catch (error) {
    receipt = {
      state:
        !dispatched ||
        (error instanceof StudySpeechError && error.outcome === "known_failed")
          ? "unavailable"
          : "uncertain",
      error:
        error instanceof StudySpeechError ? error.code : "speech_unavailable",
    };
  }
  const completed = completeStudySpeech(
    store,
    options.key,
    options.requestHash,
    receipt,
  );
  // Resolve with the authoritative winner, never with a losing late timeout.
  // If history closed during I/O, keep accounting the actual provider outcome
  // without reviving private lesson data or inventing a refund.
  const resolved = completed?.receipt ?? receipt;
  if (reservation) {
    const state =
      resolved.state === "assessed"
        ? "succeeded"
        : resolved.state === "unavailable"
          ? "refused"
          : "unknown";
    await (
      completed?.completionEvidence
        ? reservation.resolveDigest(state, completed.completionEvidence)
        : reservation.resolve(state, resolved)
    ).catch(() => undefined);
  }
  return (
    completed?.receipt ?? {
      state: "unavailable",
      error: "study_history_expired",
    }
  );
}
