import { hashJson, insist } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import {
  isWeb2Deployment,
  type CommunityDeploymentProfile,
} from "./community-deployment-profile.ts";
import {
  readPrivatePracticeProfile,
  type PrivatePracticeProfile,
} from "./community-private-practice-profile.ts";
import { studyVersion, type StudyEnv } from "./study-community.ts";
import { karaokeAvailable } from "./karaoke-community.ts";
import { privateStudyV5Profile } from "./study-v5-profile.ts";
export interface CommunityPrivatePracticeEnv extends StudyEnv {
  COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON?: string;
}
export function communityPrivatePractice(
  env: CommunityPrivatePracticeEnv,
  deployment: CommunityDeploymentProfile,
) {
  if (!isWeb2Deployment(deployment)) {
    insist(
      env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON === undefined,
      "private_practice_deployment_changed",
      503,
    );
    return null;
  }
  return readPrivatePracticeProfile(
    env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON,
    {
      communityId: deployment.directoryProfile.communityId,
      installationId: deployment.directoryProfile.installationId,
      deploymentDigest: hashJson(deployment),
    },
  );
}
export function requirePrivateStudy(
  env: StudyEnv,
  config: CommunityConfig,
  selection: PrivatePracticeProfile | null,
) {
  const selected = selection?.activities.study;
  insist(
    selected &&
      studyVersion(env, config) === 5 &&
      hashJson(privateStudyV5Profile(env, config.communityId)) ===
        selected.profileHash,
    "study_private_v5_runtime_required",
    503,
  );
}

export function requirePrivateKaraoke(
  env: StudyEnv,
  config: CommunityConfig,
  selection: PrivatePracticeProfile | null,
) {
  const selected = selection?.activities.karaoke;
  insist(
    selected &&
      env.STUDY_RUNTIME === "private-v5" &&
      env.KARAOKE_SERVICE_MODE === "internal" &&
      env.KARAOKE_PAYMENT_CHAIN_ID === "6343" &&
      env.KARAOKE_SIGNATURE_CHAIN_ID === "6343" &&
      env.KARAOKE_OPERATOR_ORIGIN === config.app.origin &&
      env.STUDY_RESULTS_V4_CONTRACT === undefined &&
      env.STUDY_RESULTS_V3_CONTRACT === undefined &&
      karaokeAvailable(env, config) &&
      hashJson(privateStudyV5Profile(env, config.communityId)) === selected.profileHash,
    "private_karaoke_runtime_unavailable",
    503,
  );
  return selected.profileHash as `0x${string}`;
}
