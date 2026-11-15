import type { Address } from "viem";
import { prepareSharedRegistration } from "../../packages/community/shared-registration-chain.ts";
import type { SharedDirectoryProfile } from "../../packages/community/shared-directory.ts";

// Explicit successor entrypoint; historical configuration-plan.ts is unchanged.
export function sharedConfigurationPlan(profile: SharedDirectoryProfile, config: unknown, uri: string, admin: Address) {
  return prepareSharedRegistration(profile, config, uri, admin);
}
