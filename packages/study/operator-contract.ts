import type { Address, Hex } from "viem";
import { check } from "../protocol/index.ts";
import { studyExercisesHash } from "../protocol/learning-results-v3.ts";
import { STUDY_LESSON_LIFETIME_MS } from "./lesson.ts";

export interface StudyLessonOffer {
  lessonId: string;
  learner: Address;
  sourceDigest: Hex;
  startedAt: number;
  expiresAt: number;
  exercises: { ordinal: number; lineId: Hex; language: string }[];
}
export const studyId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
export function validateStudyOffer(value: StudyLessonOffer, nowS: number) {
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
      value.expiresAt === value.startedAt + STUDY_LESSON_LIFETIME_MS &&
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
      transcript: { text: string; language: string | null };
    };
export interface StudySpeechStatus {
  parameters: StudySpeechParameters;
  audioDigest: Hex;
  receipt: StudySpeechReceipt;
}
