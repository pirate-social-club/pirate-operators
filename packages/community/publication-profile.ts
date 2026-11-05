import type { CommunityConfig } from "./config-manifest.ts";
import { canonical, hashJson, insist } from "./common.ts";
import type { PostingBounds } from "./publication-posting.ts";
import type { PostsProfile } from "./post-chain.ts";

export interface PublicationExecutionProfile {
  schema: "pirate.publication-execution-profile/1";
  configurationSha256: string;
  serviceOrigin: string;
  grantHash: string;
  registrationOperator: string;
  posting: PostingBounds & {
    postsContract: string;
    postsCodeHash: string;
    deploymentBlock: string;
  };
}
interface ExecutionPorts {
  managed: { origin: string; configuration: CommunityConfig };
  release: {
    grantHash: string;
    registrationOperator: string;
    client: { origin: string; configuration: CommunityConfig };
  };
  posting: {
    bounds: PostingBounds;
    profile: PostsProfile;
    config: CommunityConfig;
  };
}
export function publicationExecutionProfile(
  ports: ExecutionPorts,
): PublicationExecutionProfile {
  const configurationSha256 = hashJson(ports.managed.configuration);
  insist(
    ports.release.client.origin === ports.managed.origin &&
      hashJson(ports.release.client.configuration) === configurationSha256 &&
      hashJson(ports.posting.config) === configurationSha256 &&
      ports.posting.profile.address ===
        ports.managed.configuration.postsContract,
    "publication_service_profile_inconsistent",
    503,
  );
  return {
    configurationSha256,
    schema: "pirate.publication-execution-profile/1",
    serviceOrigin: ports.managed.origin,
    grantHash: ports.release.grantHash,
    registrationOperator: ports.release.registrationOperator,
    posting: {
      ...ports.posting.bounds,
      postsContract: ports.posting.profile.address,
      postsCodeHash: ports.posting.profile.runtimeCodeHash,
      deploymentBlock: ports.posting.profile.deploymentBlock.toString(),
    },
  };
}
export function requireExecutionProfile(
  authority: Record<string, unknown>,
  ports: ExecutionPorts,
) {
  insist(
    authority.execution &&
      canonical(authority.execution) ===
        canonical(publicationExecutionProfile(ports)),
    "publication_execution_profile_changed",
    409,
  );
}
