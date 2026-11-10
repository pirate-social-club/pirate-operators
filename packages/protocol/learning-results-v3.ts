// Version 3 has fresh consent and typed Study outcomes. V2 readers stay intact.
import {
  concat,
  hashTypedData,
  keccak256,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { check, digest } from "./index.ts";
import {
  enrollmentStruct,
  enrollmentTypes,
  resultStruct,
  songStruct,
  type Enrollment,
} from "./learning-results.ts";
import { STUDY_POLICY } from "../study/contracts.ts";
import { STUDY_QUEUE_POLICY } from "../study/lesson.ts";

export {
  enrollmentTypes,
  revocationTypes,
  resultCommitment,
  resultPeriod,
  type Enrollment,
  type TerminalResult,
} from "./learning-results.ts";

export const RESULT_ACTIVITY_STUDY = 2;
export const resultsV3Domain = (
  chainId: number,
  verifyingContract: Address,
) => ({
  name: "Pirate Learning Results",
  version: "3",
  chainId,
  verifyingContract,
});
export const enrollmentV3Id = (
  chainId: number,
  contract: Address,
  message: Enrollment,
) =>
  hashTypedData({
    domain: resultsV3Domain(chainId, contract),
    types: enrollmentTypes,
    primaryType: "Enrollment",
    message,
  });

export const resultsV3Abi = parseAbi([
  enrollmentStruct,
  songStruct,
  resultStruct,
  "function VERSION() view returns (uint8)",
  "function activatePolicy(uint8 activity,bytes32 policy,string uri,uint64 period)",
  "function policyFor(uint8 activity,uint64 period) view returns (bytes32)",
  "function setGrader(address grader,uint8 activity,bool allowed)",
  "function enroll(Enrollment e,bytes signature)",
  "function enrollmentDigest(Enrollment e) view returns (bytes32)",
  "function revoke(address learner,uint64 nonce,bytes signature)",
  "function publish(Result r,bytes outcomes)",
  "function correct(Result previous,bytes oldOutcomes,bytes outcomes,uint8 status)",
  "function invalidate(Result previous,bytes outcomes,bytes32 reason)",
  "function commitmentOf(Result r,bytes outcomes) pure returns (bytes32)",
  "function enrollments(address learner) view returns (bytes32 id,uint256 activities,uint64 issuedAt,uint64 expiresAt)",
  "function nextNonce(address learner) view returns (uint64)",
  "function publicityPolicy() view returns (bytes32)",
  "function communityId() view returns (bytes32)",
  "function commitments(bytes32 sessionId) view returns (bytes32)",
  "event Enrolled(address indexed learner,bytes32 indexed enrollmentId,Enrollment enrollment,uint64 issuedAt)",
  "event Revoked(address indexed learner,bytes32 indexed enrollmentId,uint64 nonce)",
  "event ResultPublished(bytes32 indexed sessionId,address indexed learner,uint32 indexed revision,Result result,bytes outcomes,bytes32 commitment,address publisher)",
  "event PolicyActivated(uint8 indexed activity,bytes32 indexed policyHash,string policyURI,uint64 effectivePeriod,uint8 clockVersion)",
  "event EligibilityChanged(address indexed learner,bool eligible,uint64 effectiveAt,bytes32 reasonCode)",
]);

export const STUDY_OUTCOME_CODES = {
  correct: 1,
  incorrect: 2,
  unpaid: 3,
  unmeasured: 4,
  unattempted: 5,
} as const;
export type StudyOutcomeStatus = keyof typeof STUDY_OUTCOME_CODES;
export interface StudyOutcome {
  sourceOrdinal: number;
  status: StudyOutcomeStatus;
}

export function studyExercisesHash(ordinals: readonly number[]): Hex {
  check(ordinals.length >= 4 && ordinals.length <= 10, "invalid_study_count");
  check(
    ordinals.every((x) => Number.isInteger(x) && x > 0 && x <= 2000),
    "invalid_source_ordinal",
  );
  check(new Set(ordinals).size === ordinals.length, "duplicate_exercise");
  return keccak256(concat(ordinals.map((x) => numberToHex(x, { size: 2 }))));
}
export function packStudyOutcomes(outcomes: readonly StudyOutcome[]): Hex {
  studyExercisesHash(outcomes.map((x) => x.sourceOrdinal));
  return concat(
    outcomes.map(({ sourceOrdinal, status }) => {
      check(
        Object.hasOwn(STUDY_OUTCOME_CODES, status),
        "invalid_study_outcome",
      );
      return concat([
        numberToHex(sourceOrdinal, { size: 2 }),
        numberToHex(STUDY_OUTCOME_CODES[status], { size: 1 }),
      ]);
    }),
  );
}
export function unpackStudyOutcomes(
  packed: Hex,
  count: number,
): StudyOutcome[] {
  check(
    Number.isInteger(count) &&
      count >= 4 &&
      count <= 10 &&
      /^0x[0-9a-f]*$/i.test(packed) &&
      packed.length === 2 + count * 6,
    "invalid_study_coverage",
  );
  const names = [
    "",
    "correct",
    "incorrect",
    "unpaid",
    "unmeasured",
    "unattempted",
  ] as const;
  const outcomes = Array.from({ length: count }, (_, i) => {
    const word = packed.slice(2 + i * 6, 8 + i * 6),
      status = parseInt(word.slice(4), 16);
    check(status >= 1 && status <= 5, "invalid_study_outcome");
    return {
      sourceOrdinal: parseInt(word.slice(0, 4), 16),
      status: names[status] as StudyOutcomeStatus,
    };
  });
  studyExercisesHash(outcomes.map((x) => x.sourceOrdinal));
  return outcomes;
}
export const studyFirstPassScore = (outcomes: readonly StudyOutcome[]) => {
  packStudyOutcomes(outcomes);
  const graded = outcomes.filter(
    (x) => x.status === "correct" || x.status === "incorrect",
  ).length;
  const correct = outcomes.filter((x) => x.status === "correct").length;
  return {
    graded,
    correct,
    total: outcomes.length,
    scoreBps: Math.floor((correct * 10000) / outcomes.length),
    qualifies:
      graded === outcomes.length && correct * 10 >= outcomes.length * 7,
  };
};

export const STUDY_SCORING_POLICY = {
  schema: "pirate.study-first-pass/1",
  activity: RESULT_ACTIVITY_STUDY,
  grading: STUDY_POLICY,
  queue: STUDY_QUEUE_POLICY,
  selection: "least-practised-distinct-text-first-occurrence/1",
  minExercises: 4,
  maxExercises: 10,
  maxPresentationsPerExercise: 3,
  maxPresentationsTotal: 20,
  publicOutcome: "first-graded-presentation",
} as const;
export const STUDY_SCORING_POLICY_HASH = digest(STUDY_SCORING_POLICY);
