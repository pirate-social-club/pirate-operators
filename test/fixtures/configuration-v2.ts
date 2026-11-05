import { defaultContentProfile } from "../../packages/moderation/content-profile.ts";
// Explicit synthetic v2 input derived from retained v1 deployment evidence.
// This does not upgrade a live registration or authorize replay of old evidence.
import { object } from "../../packages/community/common.ts";
export function configurationV2(input: unknown) {
  const value = object(input),
    policies = object(value.policies);
  return {
    ...value,
    schema: "pirate.community-config/2",
    policies: {
      ...policies,
      contentProfile: defaultContentProfile,
      recognitionSigner: policies.moderationSigner,
    },
  };
}
