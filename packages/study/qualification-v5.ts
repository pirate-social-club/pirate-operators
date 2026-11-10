import type { Hex } from "viem";
import { digest } from "../protocol/index.ts";
import { studyFirstPassScore } from "../protocol/learning-results-v3.ts";
import type { PublicResultV3 } from "../records/results-v3.ts";
import {
  STUDY_SCORING_POLICY_V5_HASH,
  validateStudyGraderActivation,
  type StudyGraderActivation,
} from "./grader-revision.ts";

/** Separate policy bytes. Readers retain the v4 policy for historical results. */
export const studyQualificationPolicyV5 = (graders: readonly string[]) => ({
  schema: "pirate.study-qualification/2" as const,
  activity: 2 as const,
  graders: graders.map((value) => value.toLowerCase()),
  scoringPolicy: STUDY_SCORING_POLICY_V5_HASH,
  terminalStatuses: [1],
  requireAllFirstPass: true,
  minCorrectNumerator: 7,
  minCorrectDenominator: 10,
});
export type StudyQualificationPolicyV5 = ReturnType<
  typeof studyQualificationPolicyV5
>;
export function qualifiesStudyResultV5(
  evidence: PublicResultV3,
  policies: ReadonlyMap<Hex, StudyQualificationPolicyV5>,
  evaluationPeriod: bigint,
  activation: StudyGraderActivation,
): boolean {
  validateStudyGraderActivation(activation);
  const { result, assessment } = evidence,
    policy = policies.get(result.qualificationPolicy);
  if (
    !evidence.verified ||
    assessment?.activity !== 2 ||
    result.activity !== 2 ||
    result.status !== 1 ||
    evidence.period < BigInt(activation.effectivePeriod) ||
    evidence.period > evaluationPeriod ||
    result.startedAt * 1000n < BigInt(activation.effectiveAtMs) ||
    result.completedAt < result.startedAt ||
    evidence.period !==
      (result.completedAt - BigInt(activation.epochStartS)) /
        BigInt(activation.periodSeconds) ||
    !policy ||
    policy.schema !== "pirate.study-qualification/2" ||
    policy.activity !== 2 ||
    digest(policy) !== result.qualificationPolicy ||
    policy.scoringPolicy !== STUDY_SCORING_POLICY_V5_HASH ||
    result.scoringPolicy !== policy.scoringPolicy ||
    !policy.graders.some(
      (value) => value.toLowerCase() === result.grader.toLowerCase(),
    ) ||
    policy.terminalStatuses.length !== 1 ||
    policy.terminalStatuses[0] !== 1 ||
    policy.requireAllFirstPass !== true ||
    policy.minCorrectNumerator !== 7 ||
    policy.minCorrectDenominator !== 10
  )
    return false;
  return studyFirstPassScore(assessment.outcomes).qualifies;
}
