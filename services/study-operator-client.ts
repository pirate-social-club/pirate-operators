// Uses the existing service binding and community ticket signer. Provider keys
// and HTTP transports remain in the operator, not in the application/browser.
import type { Hex } from "viem";
import { canonical } from "../packages/protocol/index.ts";
import {
  minimalStudyGrade,
  type StudyAssessmentPort,
} from "../packages/study/assessment.ts";
import { STUDY_POLICY } from "../packages/study/contracts.ts";
import { privateStudySource } from "./study-private-assessment.ts";
import { check, digest } from "../packages/protocol/index.ts";
import {
  authorizeStudyRequest,
  STUDY_AUTH_HEADER,
  type StudyOperatorAuthority,
  type StudyOperatorPath,
} from "../packages/study/operator-auth.ts";
import type {
  AnyStudyLessonOffer,
  StudyLessonOffer,
  StudyLessonOfferV4,
  StudySpeechReceipt,
  StudySpeechStatus,
} from "../packages/study/operator-contract.ts";
import {
  StudySpeechError,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";
import type {
  StudyAuthorizationBinding,
  StudyBinding,
  StudyOperatorBinding,
} from "./study-operator.ts";
import {
  telegramStudyDenial,
  type TelegramStudyDenial,
} from "../packages/study/telegram-publication.ts";
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
  beforeSend?: () => Promise<void>,
) {
  const header = await authorizeStudyRequest(
    ports.authority,
    path,
    bytes,
    parameters,
    ports.issuerKey,
    Math.floor((ports.now ?? Date.now)() / 1000),
  );
  if (beforeSend) await beforeSend();
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
export async function denyManagedStudyPublication(
  ports: StudyOperatorPorts,
  value: TelegramStudyDenial,
  beforeSend?: () => Promise<void>,
) {
  const denial = telegramStudyDenial(value);
  check(
    denial.communityId === ports.authority.communityId,
    "study_telegram_fence_context_changed",
  );
  const receipt = await call<{ denialHash: string; recorded: boolean }>(
    ports,
    "/study/telegram/deny",
    encoded(denial),
    {},
    beforeSend,
  );
  check(
    receipt.recorded === true && receipt.denialHash === digest(denial),
    "study_telegram_denial_not_recorded",
  );
  return receipt;
}

/** A V3 offer binds an enrollment; a V4 offer binds its sign-in authorization. */
export function bindManagedStudy(
  ports: StudyOperatorPorts,
  offer: StudyLessonOffer,
): Promise<StudyOperatorBinding>;
export function bindManagedStudy(
  ports: StudyOperatorPorts,
  offer: StudyLessonOfferV4,
): Promise<StudyAuthorizationBinding>;
export function bindManagedStudy(
  ports: StudyOperatorPorts,
  offer: AnyStudyLessonOffer,
) {
  return call<StudyBinding>(ports, "/study/bind", encoded(offer));
}
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
  binding: StudyBinding,
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
      if (status.receipt.state === "assessed") {
        check(
          status.receipt.transcript && !status.receipt.grade,
          "study_private_assessment_required",
        );
        return { state: "assessed", transcript: status.receipt.transcript };
      }
      return status.receipt.state === "unavailable" ? status.receipt : null;
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
      if (receipt.state === "assessed") {
        check(
          receipt.transcript && !receipt.grade,
          "study_private_assessment_required",
        );
        return receipt.transcript;
      }
      throw new StudySpeechError(
        receipt.error,
        receipt.state === "unavailable" ? "known_failed" : "unknown",
      );
    },
  };
}

/** Uses the original signed public source and policy. Actual transcripts never
 * cross this linked client boundary; pending work is queried, never resent. */
export function managedStudyAssessor(
  ports: StudyOperatorPorts,
  binding: StudyBinding,
): StudyAssessmentPort {
  const source = privateStudySource(binding.offer);
  const policy = binding.offer.graderRevision ?? STUDY_POLICY;
  const grade = (receipt: StudySpeechReceipt) => {
    if (receipt.state === "assessed") {
      check(
        receipt.grade && !receipt.transcript,
        "study_private_assessment_required",
      );
      return minimalStudyGrade(receipt.grade, policy);
    }
    throw new StudySpeechError(
      receipt.error,
      receipt.state === "unavailable" ? "known_failed" : "unknown",
    );
  };
  return {
    async assess(audio, contentType, line, context) {
      check(
        context.lessonId === binding.offer.lessonId &&
          canonical(
            source.selected.find(
              (expected) => expected.lineId === context.lineId,
            ),
          ) === canonical(line),
        "study_reference_mismatch",
      );
      const receipt = await call<StudySpeechReceipt>(
        ports,
        "/study/speech",
        audio,
        { ...context, contentType },
      );
      return grade(receipt);
    },
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
      if (status.receipt.state === "assessed")
        return { state: "assessed", grade: grade(status.receipt) };
      return status.receipt.state === "unavailable" ? status.receipt : null;
    },
  };
}
