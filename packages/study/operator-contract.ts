import type { Address, Hex } from "viem";
import type { TelegramStudyFence } from "./telegram-publication.ts";
import { check } from "../protocol/index.ts";
import { studyExercisesHash } from "../protocol/learning-results-v3.ts";
import {
  STUDY_LESSON_LIFETIME_MS,
  STUDY_LESSON_NO_DEADLINE,
} from "./lesson.ts";

/** A V3 lesson offer, bound to the learner's learning enrollment. */
export interface StudyLessonOffer {
  /** Trusted issuer freezes connected Telegram provenance in the binding.
   * Trial history never uses this public-result lesson contract. */
  speechChannel?: "telegram-linked";
  telegramFence?: TelegramStudyFence;
  graderRevision?: "script_aware_token_phonetic_v5";
  lessonId: string;
  learner: Address;
  sourceDigest: Hex;
  startedAt: number;
  expiresAt: number;
  exercises: { ordinal: number; lineId: Hex; language: string }[];
  authorizationId?: never;
}
/**
 * A V4 lesson offer: the V3 fields plus the sign-in authorization the lesson
 * started under. A V3 offer never carries this field, so its bytes and hash
 * are unchanged.
 */
export interface StudyLessonOfferV4
  extends Omit<StudyLessonOffer, "authorizationId"> {
  authorizationId: Hex;
}
export type AnyStudyLessonOffer = StudyLessonOffer | StudyLessonOfferV4;
export const studyId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
export function validateStudyOffer(
  value: AnyStudyLessonOffer,
  nowS: number,
  version: 3 | 4 = 3,
) {
  check(
    value &&
      (value.speechChannel === undefined ||
        (version === 4 && value.speechChannel === "telegram-linked")),
    "invalid_study_speech_channel",
  );
  check(
    value &&
      (value.graderRevision === undefined ||
        (version === 4 &&
          value.graderRevision === "script_aware_token_phonetic_v5")),
    "invalid_study_grader_revision",
  );
  check(
    version === 4
      ? value &&
          typeof value === "object" &&
          typeof value.authorizationId === "string" &&
          /^0x[0-9a-f]{64}$/.test(value.authorizationId) &&
          !/^0x0+$/.test(value.authorizationId) &&
          // A V4 lesson is always a new lesson, with no learner time limit.
          value.expiresAt === STUDY_LESSON_NO_DEADLINE
      : value && typeof value === "object" && !("authorizationId" in value),
    "invalid_study_lesson_binding",
  );
  check(
    value &&
      typeof value === "object" &&
      studyId(value.lessonId) &&
      /^0x[0-9a-f]{40}$/i.test(value.learner) &&
      !/^0x0+$/.test(value.learner) &&
      /^0x[0-9a-f]{64}$/.test(value.sourceDigest) &&
      Number.isSafeInteger(value.startedAt) &&
      Number.isSafeInteger(value.expiresAt) &&
      value.startedAt >= 0 &&
      value.startedAt <= nowS * 1000 + 5000 &&
      value.expiresAt > nowS * 1000 &&
      // Lessons have no time limit. A lesson started before that change keeps
      // its original one-hour bound until it is closed.
      (value.expiresAt === STUDY_LESSON_NO_DEADLINE ||
        value.expiresAt === value.startedAt + STUDY_LESSON_LIFETIME_MS) &&
      Array.isArray(value.exercises),
    "invalid_study_lesson_binding",
  );
  const exercisesHash = studyExercisesHash(
    value.exercises.map((x) => x.ordinal),
  );
  check(
    value.exercises.every(
      (x) =>
        /^0x[0-9a-f]{64}$/.test(x.lineId) &&
        typeof x.language === "string" &&
        /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(x.language),
    ) &&
      new Set(value.exercises.map((x) => x.lineId)).size ===
        value.exercises.length,
    "invalid_study_lesson_binding",
  );
  return exercisesHash;
}
export interface StudySpeechParameters {
  lessonId: string;
  attemptId: string;
  lineId: Hex;
  presentationNumber: number;
  takeNumber: number;
  contentType: string;
  durationMs: number;
}
export type StudySpeechReceipt =
  | { state: "assessing" | "uncertain"; error: string }
  | { state: "unavailable"; error: string }
  | {
      state: "assessed";
      transcript: {
        text: string;
        language: string | null;
        languageConfidence?: number | null;
      };
    };
export interface StudySpeechStatus {
  parameters: StudySpeechParameters;
  audioDigest: Hex;
  receipt: StudySpeechReceipt;
}
