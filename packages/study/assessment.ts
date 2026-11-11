import { check } from "../protocol/index.ts";
import {
  gradeTranscriptV2,
  type StudyTranscriptGradeV2,
} from "./transcript-grading.ts";
import { assessStudySpokenRerecord } from "./spoken-rerecord.ts";
import type { AdmittedStudyGrader } from "./grader-revision.ts";
import type { StudyLine } from "./contracts.ts";
import type {
  StudyTranscript,
  StudySpeechContext,
} from "./speech-transcriber.ts";

/** Actual assessment facts without a fabricated transcript or token diff. */
export type StudyMinimalGrade = Pick<
  StudyTranscriptGradeV2,
  "correct" | "matchKind" | "policyRevision" | "rerecordReason"
> & {
  heardTranscript?: never;
  matched?: never;
  missing?: never;
  extra?: never;
  substituted?: never;
};
export type StudyGrade = StudyTranscriptGradeV2 | StudyMinimalGrade;
export function minimalStudyGrade(
  value: unknown,
  policy?: AdmittedStudyGrader,
): StudyMinimalGrade {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "study_minimal_grade_invalid",
  );
  const x = value as Record<string, unknown>;
  check(
    Object.keys(x).every((k) =>
      ["correct", "matchKind", "policyRevision", "rerecordReason"].includes(k),
    ) &&
      typeof x.correct === "boolean" &&
      ["exact", "phonetic", "none"].includes(String(x.matchKind)) &&
      [
        "script_aware_token_phonetic_v4",
        "script_aware_token_phonetic_v5",
      ].includes(String(x.policyRevision)) &&
      (policy === undefined || x.policyRevision === policy) &&
      (x.rerecordReason === undefined ||
        (x.policyRevision === "script_aware_token_phonetic_v5" &&
          [
            "language_mismatch",
            "low_voice_overlap",
            "single_insertion",
          ].includes(String(x.rerecordReason)))),
    "study_minimal_grade_invalid",
  );
  return {
    correct: x.correct,
    matchKind: x.matchKind as StudyMinimalGrade["matchKind"],
    policyRevision: x.policyRevision as StudyMinimalGrade["policyRevision"],
    ...(x.rerecordReason === undefined
      ? {}
      : {
          rerecordReason: x.rerecordReason as NonNullable<
            StudyMinimalGrade["rerecordReason"]
          >,
        }),
  };
}
export function reduceStudyGrade(
  grade: StudyTranscriptGradeV2,
): StudyMinimalGrade {
  return minimalStudyGrade({
    correct: grade.correct,
    matchKind: grade.matchKind,
    policyRevision: grade.policyRevision,
    ...(grade.rerecordReason ? { rerecordReason: grade.rerecordReason } : {}),
  });
}
export interface StudyAssessmentPort {
  assess(
    audio: Uint8Array,
    contentType: string,
    line: StudyLine,
    context: StudySpeechContext,
  ): Promise<StudyMinimalGrade>;
  recover(
    context: StudySpeechContext,
    audioDigest: string,
  ): Promise<
    | { state: "assessed"; grade: StudyMinimalGrade }
    | { state: "unavailable"; error: string }
    | null
  >;
}

export function gradeStudySpeech(
  line: StudyLine,
  transcript: StudyTranscript,
  policy: AdmittedStudyGrader,
  takeNumber: number,
) {
  const grade = gradeTranscriptV2(
    line.text,
    transcript.text,
    line.language,
    policy,
  );
  if (policy === "script_aware_token_phonetic_v5" && takeNumber === 1) {
    const assessment = assessStudySpokenRerecord({
      grade,
      expectedLanguage: line.language,
      detectedLanguage: transcript.language,
      detectedLanguageConfidence: transcript.languageConfidence ?? null,
    });
    if (assessment.candidateReason)
      return { ...grade, rerecordReason: assessment.candidateReason };
  }
  return grade;
}
