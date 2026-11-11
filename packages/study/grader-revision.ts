import { check, digest } from "../protocol/index.ts";
import {
  STUDY_SCORING_POLICY,
  STUDY_SCORING_POLICY_HASH,
} from "../protocol/learning-results-v3.ts";
import {
  STUDY_TRANSCRIPT_GRADER_POLICY_V4,
  STUDY_TRANSCRIPT_GRADER_POLICY_V5,
} from "./transcript-grading.ts";

export type AdmittedStudyGrader =
  | typeof STUDY_TRANSCRIPT_GRADER_POLICY_V4
  | typeof STUDY_TRANSCRIPT_GRADER_POLICY_V5;
export const STUDY_SCORING_POLICY_V5 = {
  ...STUDY_SCORING_POLICY,
  grading: STUDY_TRANSCRIPT_GRADER_POLICY_V5,
  rerecord: "study_spoken_rerecord_v1",
};
export const STUDY_SCORING_POLICY_V5_HASH = digest(STUDY_SCORING_POLICY_V5);
export interface StudyGraderActivation {
  schema: "pirate.study-grader-activation/1";
  revision: typeof STUDY_TRANSCRIPT_GRADER_POLICY_V5;
  epochStartS: number;
  periodSeconds: number;
  effectivePeriod: number;
  effectiveAtMs: number;
}
export function validateStudyGraderActivation(value: StudyGraderActivation) {
  check(
    value.schema === "pirate.study-grader-activation/1" &&
      value.revision === STUDY_TRANSCRIPT_GRADER_POLICY_V5 &&
      [
        value.epochStartS,
        value.periodSeconds,
        value.effectivePeriod,
        value.effectiveAtMs,
      ].every(Number.isSafeInteger) &&
      value.epochStartS >= 0 &&
      value.periodSeconds > 0 &&
      value.effectivePeriod >= 0 &&
      value.effectiveAtMs ===
        (value.epochStartS + value.effectivePeriod * value.periodSeconds) *
          1000,
    "study_grader_activation_invalid",
  );
  return value;
}
export function studyGraderAt(
  startedAt: number,
  activation?: StudyGraderActivation,
): AdmittedStudyGrader {
  check(
    Number.isSafeInteger(startedAt) && startedAt >= 0,
    "invalid_study_start",
  );
  return activation &&
    startedAt >= validateStudyGraderActivation(activation).effectiveAtMs
    ? STUDY_TRANSCRIPT_GRADER_POLICY_V5
    : STUDY_TRANSCRIPT_GRADER_POLICY_V4;
}
/** Release-plan gate. Runtime validation must still accept the same frozen
 * activation after its timestamp passes; only admission enforces future time. */
export function reviewStudyGraderActivation(
  value: StudyGraderActivation,
  reviewedAtMs: number,
) {
  validateStudyGraderActivation(value);
  check(
    Number.isSafeInteger(reviewedAtMs) &&
      reviewedAtMs >= 0 &&
      value.effectiveAtMs > reviewedAtMs,
    "study_grader_activation_not_prospective",
  );
  return value;
}
export const studyScoringPolicyHash = (
  revision: AdmittedStudyGrader = STUDY_TRANSCRIPT_GRADER_POLICY_V4,
) =>
  revision === STUDY_TRANSCRIPT_GRADER_POLICY_V5
    ? STUDY_SCORING_POLICY_V5_HASH
    : STUDY_SCORING_POLICY_HASH;
