// Compact publication facts. Unpublished first-pass grades remain private.
import { zeroHash, type Address, type Hex } from "viem";
import type { LyricManifest } from "../community/lyric-manifest.ts";
import { check, digest } from "../protocol/index.ts";
import {
  unpackStudyOutcomes,
  studyExercisesHash,
  STUDY_SCORING_POLICY_HASH,
  type TerminalResult,
} from "../protocol/learning-results-v3.ts";
import { studySourceSelection } from "./public-source.ts";
import type { StudyPublicationGrant } from "./result-adapter.ts";

export interface StudyTerminalFacts {
  schema: "pirate.study-terminal-facts/1";
  startedAt: number;
  completedAt: number;
  expiresAt: number;
  status: "completed" | "abandoned" | "expired";
  outcomes: Hex;
}

/** The existing authenticated community issuer attests the validated queue. */
export function studyFactsBundle(input: {
  lessonId: string;
  source: LyricManifest;
  terminal: StudyTerminalFacts;
  enrollment: StudyPublicationGrant;
  learner: Address;
  grader: Address;
  qualificationPolicy: Hex;
}): { result: TerminalResult; outcomes: Hex } {
  const { terminal: facts, enrollment, source } = input;
  check(
    facts &&
      facts.schema === "pirate.study-terminal-facts/1" &&
      Object.keys(facts).sort().join() ===
        [
          "schema",
          "startedAt",
          "completedAt",
          "expiresAt",
          "status",
          "outcomes",
        ]
          .sort()
          .join() &&
      ["completed", "abandoned", "expired"].includes(facts.status),
    "invalid_study_terminal_facts",
  );
  check(
    Number.isSafeInteger(facts.startedAt) &&
      facts.startedAt >= 0 &&
      Number.isSafeInteger(facts.completedAt) &&
      facts.completedAt >= facts.startedAt &&
      Number.isSafeInteger(facts.expiresAt) &&
      facts.expiresAt > facts.startedAt &&
      (facts.status === "expired"
        ? facts.completedAt === facts.expiresAt
        : facts.completedAt < facts.expiresAt),
    "invalid_study_time",
  );
  check(
    input.lessonId.length > 0 &&
      input.lessonId.length <= 128 &&
      enrollment.id !== zeroHash,
    "invalid_study_publication_identity",
  );
  check(
    typeof facts.outcomes === "string" &&
      /^0x(?:[0-9a-f]{6}){4,10}$/.test(facts.outcomes),
    "invalid_study_outcomes",
  );
  const count = (facts.outcomes.length - 2) / 6;
  const outcomes = unpackStudyOutcomes(facts.outcomes, count);
  check(
    outcomes.every(
      ({ status }) =>
        status !== "unpaid" &&
        (facts.status !== "completed" ||
          status === "correct" ||
          status === "incorrect"),
    ),
    "invalid_study_first_pass",
  );
  const ordinals = outcomes.map(({ sourceOrdinal }) => sourceOrdinal);
  const selected = studySourceSelection(source, ordinals);
  const startedAt = Math.floor(facts.startedAt / 1000),
    completedAt = Math.floor(facts.completedAt / 1000);
  check(
    Number.isSafeInteger(enrollment.issuedAt) &&
      Number.isSafeInteger(enrollment.expiresAt) &&
      startedAt >= enrollment.issuedAt &&
      completedAt < enrollment.expiresAt,
    "study_enrollment_mismatch",
  );
  return {
    result: {
      sessionId: digest({
        schema: "pirate.study-result-id/1",
        enrollmentId: enrollment.id,
        lessonId: input.lessonId,
      }),
      learner: input.learner,
      enrollmentId: enrollment.id,
      song: {
        chainId: BigInt(source.chainId),
        posts: source.postsContract,
        communityId: source.communityId,
        postId: source.postId,
      },
      contentRevision: selected.hash,
      exercisesHash: studyExercisesHash(ordinals),
      linesTotal: count,
      activity: 2,
      grader: input.grader,
      scoringPolicy: STUDY_SCORING_POLICY_HASH,
      qualificationPolicy: input.qualificationPolicy,
      startedAt: BigInt(startedAt),
      completedAt: BigInt(completedAt),
      status:
        facts.status === "completed" ? 1 : facts.status === "abandoned" ? 2 : 3,
      revision: 1,
      supersedes: zeroHash,
    },
    outcomes: facts.outcomes,
  };
}
