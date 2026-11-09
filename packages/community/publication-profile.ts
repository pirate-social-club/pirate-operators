import type { CommunityConfig } from "./config-manifest.ts";
import { canonical, hashJson, insist } from "./common.ts";
import type { PostingBounds } from "./publication-posting.ts";
import type { PostsProfile } from "./post-chain.ts";
import {
  ownerBudgetKey,
  type OwnerBudgetGrant,
} from "../release/owner-grant.ts";

type ExecutionPosting = PostingBounds & {
  postsContract: string;
  postsCodeHash: string;
  deploymentBlock: string;
};
export type PublicationExecutionProfile =
  | {
      schema: "pirate.publication-execution-profile/1";
      configurationSha256: string;
      serviceOrigin: string;
      grantHash: string;
      registrationOperator: string;
      posting: ExecutionPosting;
    }
  | {
      /** Owner jobs bind the owner scope and window, not a grant hash, so a
       * replacement grant inside the window does not strand in-flight jobs. */
      schema: "pirate.publication-execution-profile/2";
      configurationSha256: string;
      serviceOrigin: string;
      ownerScope: string;
      ownerWindow: string;
      posting: ExecutionPosting;
    };
/** The registered profile; curated amendments only ever bind this shape. */
export type RegisteredExecutionProfile = Extract<
  PublicationExecutionProfile,
  { schema: "pirate.publication-execution-profile/1" }
>;
interface ExecutionPorts {
  managed: { origin: string; configuration: CommunityConfig };
  release: {
    grantHash: string;
    registrationOperator?: string;
    ownerGrant?: OwnerBudgetGrant;
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
  const posting = {
    ...ports.posting.bounds,
    postsContract: ports.posting.profile.address,
    postsCodeHash: ports.posting.profile.runtimeCodeHash,
    deploymentBlock: ports.posting.profile.deploymentBlock.toString(),
  };
  if (ports.release.ownerGrant) {
    const key = ownerBudgetKey(ports.release.ownerGrant, "songs");
    return {
      configurationSha256,
      schema: "pirate.publication-execution-profile/2",
      serviceOrigin: ports.managed.origin,
      ownerScope: key.scope,
      ownerWindow: key.period,
      posting,
    };
  }
  insist(
    ports.release.registrationOperator,
    "release_runtime_unconfigured",
    503,
  );
  return {
    configurationSha256,
    schema: "pirate.publication-execution-profile/1",
    serviceOrigin: ports.managed.origin,
    grantHash: ports.release.grantHash,
    registrationOperator: ports.release.registrationOperator,
    posting,
  };
}
/** For registered ports only; refuses owner ports. */
export function registeredExecutionProfile(
  ports: ExecutionPorts,
): RegisteredExecutionProfile {
  const profile = publicationExecutionProfile(ports);
  insist(
    profile.schema === "pirate.publication-execution-profile/1",
    "registered_execution_profile_required",
    409,
  );
  return profile;
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
