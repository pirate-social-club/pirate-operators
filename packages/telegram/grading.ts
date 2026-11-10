import { STUDY_POLICY, type StudyLine } from "../study/contracts.ts";
import {
  gradeTranscriptV2,
  type StudyTranscriptGradeV2,
  type StudyTranscriptGraderPolicyRevision,
} from "../study/transcript-grading.ts";
import type { StudyTranscript } from "../study/speech-transcriber.ts";

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
