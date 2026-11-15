import { configurationState, isSharedConfiguration, parseConfiguration, advanceConfiguration, type ConfigurationState, type SharedCommunityConfig } from "./config-manifest.ts";
import { insist } from "./common.ts";
import { validateSharedProfile, type SharedDirectoryProfile } from "./shared-directory.ts";

export function validateSharedConfig(value: unknown, profile: SharedDirectoryProfile,
  state: ConfigurationState = configurationState(), atBlock?: bigint): SharedCommunityConfig {
  const p = validateSharedProfile(profile);
  const config = parseConfiguration(value);
  insist(isSharedConfiguration(config) && config.chainId === p.chainId &&
    config.directory === p.directory && config.registry === p.registry && config.communityId === p.communityId &&
    config.communityKey === p.communityKey && config.installationId === p.installationId &&
    config.app.origin === p.hostingOrigin && config.tld === p.tld && config.namespaceId === p.namespaceId &&
    config.registrySourceCommit === p.registrySourceCommit && config.registryCodeHash === p.registryCodeHash &&
    config.registryAbiSha256 === p.registryAbiSha256, "shared_configuration_profile_mismatch");
  advanceConfiguration(state, config, atBlock);
  return config;
}
