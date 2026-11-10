import type { Hex } from "viem";
import { digest } from "../protocol/index.ts";
import {
  studyFirstPassScore,
  STUDY_SCORING_POLICY_HASH,
} from "../protocol/learning-results-v3.ts";
import type { PublicResultV3 } from "./results-v3.ts";

export const studyQualificationPolicy = (graders: readonly string[]) =>
  ({
    schema: "pirate.study-qualification/1",
    activity: 2,
    graders: graders.map((x) => x.toLowerCase()),
    scoringPolicy: STUDY_SCORING_POLICY_HASH,
    terminalStatuses: [1],
    requireAllFirstPass: true,
    minCorrectNumerator: 7,
    minCorrectDenominator: 10,
  }) as const;
export type StudyQualificationPolicy = ReturnType<
  typeof studyQualificationPolicy
>;

/** This is qualification evidence, not ticket purchase or payout authorization. */
export function qualifiesStudyResult(
  evidence: PublicResultV3,
  policies: ReadonlyMap<Hex, StudyQualificationPolicy>,
  evaluationPeriod: bigint,
): boolean {
  const { result: r, assessment } = evidence,
    policy = policies.get(r.qualificationPolicy);
  if (
    !evidence.verified ||
    assessment?.activity !== 2 ||
    r.activity !== 2 ||
    r.status !== 1 ||
    evidence.period < 0n ||
    evidence.period > evaluationPeriod ||
    !policy ||
    digest(policy) !== r.qualificationPolicy ||
    policy.schema !== "pirate.study-qualification/1" ||
    policy.activity !== 2 ||
    policy.scoringPolicy !== STUDY_SCORING_POLICY_HASH ||
    r.scoringPolicy !== policy.scoringPolicy ||
    !policy.graders.some((x) => x.toLowerCase() === r.grader.toLowerCase()) ||
    policy.terminalStatuses.length !== 1 ||
    policy.terminalStatuses[0] !== 1 ||
    policy.requireAllFirstPass !== true ||
    policy.minCorrectNumerator !== 7 ||
    policy.minCorrectDenominator !== 10
  )
    return false;
  return studyFirstPassScore(assessment.outcomes).qualifies;
}
