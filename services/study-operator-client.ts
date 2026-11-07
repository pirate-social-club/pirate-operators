// Uses the existing service binding and community ticket signer. Provider keys
// and HTTP transports remain in the operator, not in the application/browser.
import type { Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  authorizeStudyRequest,
  STUDY_AUTH_HEADER,
  type StudyOperatorAuthority,
  type StudyOperatorPath,
} from "../packages/study/operator-auth.ts";
import type {
  StudyLessonOffer,
  StudySpeechReceipt,
  StudySpeechStatus,
} from "../packages/study/operator-contract.ts";
import {
  StudySpeechError,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";
import type { StudyOperatorBinding } from "./study-operator.ts";
import type {
  StudyTerminalRequest,
  StudyPublicationReceipt,
} from "../packages/study/publication.ts";

export interface StudyOperatorPorts {
  binding: Fetcher;
  authority: StudyOperatorAuthority;
  issuerKey: Hex;
  now?: () => number;
}
async function call<T>(
  ports: StudyOperatorPorts,
  path: StudyOperatorPath,
  bytes: Uint8Array,
  parameters: Record<string, unknown> = {},
) {
  const header = await authorizeStudyRequest(
    ports.authority,
    path,
    bytes,
    parameters,
    ports.issuerKey,
    Math.floor((ports.now ?? Date.now)() / 1000),
  );
  const response = await ports.binding.fetch(`http://operator${path}`, {
    method: "POST",
    headers: { [STUDY_AUTH_HEADER]: header },
    body: new Uint8Array(bytes).buffer,
  });
  const body = (await response.json()) as { error?: string };
  check(response.ok, body.error ?? "study_operator_unavailable");
  return body as T;
}
const encoded = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
export const bindManagedStudy = (
  ports: StudyOperatorPorts,
  offer: StudyLessonOffer,
) => call<StudyOperatorBinding>(ports, "/study/bind", encoded(offer));
export const publishManagedStudy = (
  ports: StudyOperatorPorts,
  input: StudyTerminalRequest,
) => call<StudyPublicationReceipt>(ports, "/study/terminal", encoded(input));
export const managedStudyReceipt = (
  ports: StudyOperatorPorts,
  lessonId: string,
  attemptId: string,
) =>
  call<StudySpeechStatus>(
    ports,
    "/study/speech/status",
    encoded({ lessonId, attemptId }),
  );
export function managedStudyTranscriber(
  ports: StudyOperatorPorts,
  binding: StudyOperatorBinding,
): StudyTranscriber {
  return {
    providerRetention: "stored",
    async recover(context, audioDigest) {
      const status = await managedStudyReceipt(
        ports,
        context.lessonId,
        context.attemptId,
      );
      check(
        context.lessonId === binding.offer.lessonId &&
          status.audioDigest === audioDigest &&
          Object.entries(context).every(
            ([key, value]) =>
              status.parameters[key as keyof typeof status.parameters] ===
              value,
          ),
        "study_speech_receipt_changed",
      );
      return status.receipt.state === "assessed" ||
        status.receipt.state === "unavailable"
        ? status.receipt
        : null;
    },
    async transcribe(audio, contentType, language, context) {
      check(
        context && context.lessonId === binding.offer.lessonId,
        "study_lesson_not_bound",
      );
      check(
        binding.offer.exercises.some(
          (line) =>
            line.lineId === context.lineId && line.language === language,
        ),
        "study_reference_mismatch",
      );
      const receipt = await call<StudySpeechReceipt>(
        ports,
        "/study/speech",
        audio,
        { ...context, contentType },
      );
      if (receipt.state === "assessed") return receipt.transcript;
      throw new StudySpeechError(
        receipt.error,
        receipt.state === "unavailable" ? "known_failed" : "unknown",
      );
    },
  };
}
