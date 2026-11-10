import type { Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import type {
  StudySpeechParameters,
  StudySpeechReceipt,
} from "../packages/study/operator-contract.ts";
import type { ResultStore } from "./learning-transactions.ts";
import { closedStudyPublication } from "./study-private-publication.ts";
import type { StudyTranscriber } from "../packages/study/speech-transcriber.ts";
import {
  reconcileCommunitySpeech,
  type SpeechAdmissionEnv,
} from "./study-speech-reservation.ts";

export interface StudySpeechJob {
  bindingHash: Hex;
  requestHash: Hex;
  audioDigest: Hex;
  parameters: StudySpeechParameters;
  receipt: StudySpeechReceipt;
  expiresAt: number;
}

/** First terminal receipt wins, across status recovery and late dispatch I/O.
 * The comparison and write share one store transaction without an await. */
export function completeStudySpeech(
  store: ResultStore,
  key: string,
  requestHash: Hex,
  receipt: StudySpeechReceipt,
): StudySpeechJob | null {
  return store.transaction(() => {
    const current = store.get<StudySpeechJob>(key);
    if (
      !current ||
      current.expiresAt <= store.now() ||
      closedStudyPublication(store, current.parameters.lessonId)
    )
      return null;
    check(current.requestHash === requestHash, "study_speech_request_changed");
    if (
      current.receipt.state === "assessed" ||
      current.receipt.state === "unavailable"
    )
      return current;
    const completed = { ...current, receipt };
    store.set(key, completed);
    return completed;
  });
}

/** Read-only provider recovery; it shares the completion transaction with the
 * dispatch path, and reconciles the budget from that transaction's winner. */
export async function recoverStudySpeech(
  env: SpeechAdmissionEnv,
  store: ResultStore,
  key: string,
  job: StudySpeechJob,
  provider?: StudyTranscriber,
): Promise<StudySpeechJob> {
  if (
    !provider?.recover ||
    !["assessing", "uncertain"].includes(job.receipt.state)
  )
    return job;
  const { contentType: _contentType, ...context } = job.parameters;
  const recovered = await provider
    .recover(context, job.audioDigest)
    .catch(() => null);
  const current = recovered
    ? completeStudySpeech(store, key, job.requestHash, recovered)
    : store.get<StudySpeechJob>(key);
  if (
    !current ||
    current.expiresAt <= store.now() ||
    closedStudyPublication(store, job.parameters.lessonId)
  )
    return {
      ...job,
      receipt: { state: "unavailable", error: "study_history_expired" },
    };
  if (
    recovered &&
    (current.receipt.state === "assessed" ||
      current.receipt.state === "unavailable")
  )
    await reconcileCommunitySpeech(
      env,
      `study:${job.parameters.attemptId}`,
      current.receipt.state === "assessed" ? "succeeded" : "refused",
      current.receipt,
    ).catch(() => undefined);
  return current;
}
