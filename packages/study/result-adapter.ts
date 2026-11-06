// Only a durably completed snapshot is admitted by this adapter. Abandonment
// and expiry need their own closed-state runtime path before publication.
import { zeroHash, type Address, type Hex } from "viem";
import type { LyricManifest } from "../community/lyric-manifest.ts";
import { canonical, check, digest } from "../protocol/index.ts";
import {
  packStudyOutcomes,
  studyExercisesHash,
  STUDY_SCORING_POLICY_HASH,
  type TerminalResult,
} from "../protocol/learning-results-v3.ts";
import {
  STUDY_QUEUE_POLICY,
  studyPresentationCap,
  type LessonState,
} from "./lesson.ts";
import { studySourceSelection } from "./public-source.ts";

export interface StudyPublicationGrant {
  id: Hex;
  issuedAt: number;
  expiresAt: number;
}

/** Grant must be the enrollment snapshot saved when this lesson was opened. */
export function completedStudyBundle(input: {
  lessonId: string;
  state: LessonState;
  source: LyricManifest;
  enrollment: StudyPublicationGrant;
  learner: Address;
  grader: Address;
  qualificationPolicy: Hex;
}): { result: TerminalResult; outcomes: Hex } {
  const { state, enrollment, source } = input;
  check(
    state.policy === STUDY_QUEUE_POLICY &&
      state.status === "completed" &&
      state.currentIndex === null &&
      state.currentAttemptId === null &&
      (state.completionReason === "all_resolved" ||
        state.completionReason === "presentation_budget"),
    "study_not_completed",
  );
  check(
    Number.isSafeInteger(state.startedAt) &&
      state.startedAt >= 0 &&
      Number.isSafeInteger(state.completedAt) &&
      state.completedAt! >= state.startedAt,
    "invalid_study_time",
  );
  check(
    input.lessonId.length > 0 &&
      input.lessonId.length <= 128 &&
      enrollment.id !== zeroHash,
    "invalid_study_publication_identity",
  );
  const ordinals = state.items.map((item) => {
    const index = source.lines.findIndex(
      (line) => line.lineId === item.line.lineId,
    );
    check(index >= 0, "study_source_mismatch");
    return index + 1;
  });
  const selected = studySourceSelection(source, ordinals);
  check(
    canonical(state.song) ===
      canonical({
        chainId: source.chainId,
        postsContract: source.postsContract,
        communityId: source.communityId,
        postId: source.postId,
        lyricRevision: source.revision,
      }),
    "study_source_mismatch",
  );
  for (const [i, item] of state.items.entries()) {
    check(
      canonical(item.line) === canonical(selected.selected[i]),
      "study_source_mismatch",
    );
    check(
      Number.isInteger(item.presentations) &&
        item.presentations >= 1 &&
        item.presentations <= 3 &&
        (item.firstPassOutcome === "correct" ||
          item.firstPassOutcome === "incorrect") &&
        typeof item.mastered === "boolean" &&
        item.resolved === (item.mastered || item.presentations === 3) &&
        (item.firstPassOutcome !== "correct" ||
          (item.mastered && item.presentations === 1)) &&
        (item.presentations !== 1 ||
          item.mastered === (item.firstPassOutcome === "correct")),
      "invalid_study_first_pass",
    );
  }
  const cap = studyPresentationCap(state.items.length);
  check(
    state.presentationCount ===
      state.items.reduce((sum, item) => sum + item.presentations, 0) &&
      state.presentationCount <= cap &&
      (state.completionReason === "all_resolved"
        ? state.items.every((item) => item.resolved)
        : state.presentationCount === cap &&
          state.items.some((item) => !item.resolved)),
    "invalid_study_completion",
  );
  const startedAt = Math.floor(state.startedAt / 1000),
    completedAt = Math.floor(state.completedAt! / 1000);
  check(
    Number.isSafeInteger(enrollment.issuedAt) &&
      Number.isSafeInteger(enrollment.expiresAt) &&
      startedAt >= enrollment.issuedAt &&
      completedAt < enrollment.expiresAt,
    "study_enrollment_mismatch",
  );
  const outcomes = packStudyOutcomes(
    state.items.map((item, i) => ({
      sourceOrdinal: ordinals[i],
      status: item.firstPassOutcome!,
    })),
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
      linesTotal: state.items.length,
      activity: 2,
      grader: input.grader,
      scoringPolicy: STUDY_SCORING_POLICY_HASH,
      qualificationPolicy: input.qualificationPolicy,
      startedAt: BigInt(startedAt),
      completedAt: BigInt(completedAt),
      status: 1,
      revision: 1,
      supersedes: zeroHash,
    },
    outcomes,
  };
}
