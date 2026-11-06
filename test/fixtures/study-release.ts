// Synthetic public target and hashes, never a live execution profile.
import {
  retainedResultsV2,
  retainedLearningController,
} from "../../harness/study-release-profile.ts";
import { firstSong } from "../../services/first-song-profile.ts";
import { learningV3PublicityPolicy } from "../../services/learning-policy-v3.ts";
export const selectionFixture = () => ({
  schema: "pirate.study-release-selection/1" as const,
  chainId: 6343 as const,
  communityId: firstSong.directoryProfile.communityId,
  controller: retainedLearningController,
  resultsV2: { ...retainedResultsV2 },
  resultsV3: {
    contract: `0x${"9".repeat(40)}` as const,
    codeHash: `0x${"1".repeat(64)}` as const,
    publicityPolicy: learningV3PublicityPolicy,
  },
  reviewedUpdate: {
    previousPlanPath:
      "docs/deployments/first-song-managed-20261105.application-plan-v15.json",
    previousProfileHash: `0x${"2".repeat(64)}`,
    expectedExecutionSha256: `0x${"3".repeat(64)}`,
    expectedResultSha256: `0x${"4".repeat(64)}`,
  },
});
