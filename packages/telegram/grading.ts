import { STUDY_POLICY, type StudyLine } from "../study/contracts.ts";
import {
  gradeTranscriptV2,
  type StudyTranscriptGradeV2,
  type StudyTranscriptGraderPolicyRevision,
} from "../study/transcript-grading.ts";
import type { StudyTranscript } from "../study/speech-transcriber.ts";

export type TelegramGrade = Pick<
  StudyTranscriptGradeV2,
  "correct" | "matchKind" | "policyRevision"
> & {
  rerecordReason?:
    | "language_mismatch"
    | "low_voice_overlap"
    | "single_insertion";
};

/** Only these assessment facts cross a Telegram persistence boundary. */
export function telegramGrade(value: unknown): TelegramGrade | null {
  if (!value || typeof value !== "object") return null;
  const { correct, matchKind, rerecordReason } =
    value as Partial<TelegramGrade>;
  const { policyRevision } = value as { policyRevision?: unknown };
  if (
    typeof correct !== "boolean" ||
    (matchKind !== "exact" &&
      matchKind !== "phonetic" &&
      matchKind !== "none") ||
    (policyRevision !== "script_aware_token_diff_v1" &&
      policyRevision !== "script_aware_token_phonetic_v2" &&
      policyRevision !== "script_aware_token_phonetic_v3" &&
      policyRevision !== "script_aware_token_phonetic_v4" &&
      policyRevision !== "script_aware_token_phonetic_v5")
  )
    return null;
  return {
    correct,
    matchKind,
    policyRevision: policyRevision as StudyTranscriptGraderPolicyRevision,
    ...(rerecordReason === "language_mismatch" ||
    rerecordReason === "low_voice_overlap" ||
    rerecordReason === "single_insertion"
      ? { rerecordReason }
      : {}),
  };
}

/** Lane5 supplies the admitted policy-at-start and complete spoken assessment,
 * including its uncounted re-record rule. No Telegram-specific grading policy. */
export interface TelegramTrialGradingPort {
  policyAt(startedAt: number): StudyTranscriptGraderPolicyRevision;
  grade(input: {
    line: StudyLine;
    transcript: StudyTranscript;
    policy: StudyTranscriptGraderPolicyRevision;
    take: number;
  }): StudyTranscriptGradeV2;
}
/** Released V4 only. A later policy requires the owning lane's explicitly
 * supplied grading port and shared queue implementation at integration. */
export const releasedTelegramGrading: TelegramTrialGradingPort = {
  policyAt: () => STUDY_POLICY,
  grade: ({ line, transcript, policy }) =>
    gradeTranscriptV2(line.text, transcript.text, line.language, policy),
};
