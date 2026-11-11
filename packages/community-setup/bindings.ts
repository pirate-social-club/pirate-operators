import { communitySetupPlan } from "./manifest.ts";
/** Fresh V4 community, with no fictional V2/V3 history. Shared runtime/profile
 * admission and Alchemy adoption are coordinator-only integration patches.
 */
export const COMMUNITY_LEARNING_PROFILE_V1 = "pirate-community-learning-v4";
export function communityLearningBindings(
  settings: unknown,
  sourceDigest: string,
) {
  const plan = communitySetupPlan(settings, sourceDigest),
    s = plan.settings;
  return {
    plan,
    operator: {
      ...plan.operatorBindings,
      OPERATOR_PROFILE: COMMUNITY_LEARNING_PROFILE_V1,
      ROLE: "operator",
      LOCAL_ONLY: "disabled",
      SERVICE_MODE: "internal",
      SIGNATURE_CHAIN_ID: String(s.chainId),
      OPERATOR_ADDRESS: s.grader,
    },
    application: {
      STUDY_RESULTS_V4_CONTRACT: s.resultsContract,
      KARAOKE_SERVICE_MODE: "internal",
      KARAOKE_OPERATOR_ADDRESS: s.grader,
      KARAOKE_OPERATOR_ORIGIN: s.operatorOrigin,
      KARAOKE_PAYMENT_CHAIN_ID: String(s.chainId),
      KARAOKE_SIGNATURE_CHAIN_ID: String(s.chainId),
    },
    operatorServiceBinding: {
      type: "service",
      name: "KARAOKE_OPERATOR",
      service: plan.resources.learningWorker,
    },
    accountId: s.accountId,
    requiredManagedBindings: [
      "LEARNING_OPERATOR_PRIVATE_KEY",
      "COMMUNITY_PUBLISHER_PRIVATE_KEY",
      "LEARNING_ISSUER_PRIVATE_KEY",
      "ELEVENLABS_API_KEY",
    ],
    unresolvedBindings: [
      "lane5-speech-key-generation-and-channel-caps",
      "reviewed-directory-and-release-profiles",
      "issuer-identity-and-contract-permissions",
      "RPC-and-account-delegate-preflight",
    ],
  };
}
