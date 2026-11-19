import type { LocalPostsEffectFence } from "../packages/community/local-posts-custody.ts";
import { publishingAttachment } from "../deploy/linux/web2-publishing-attachment.ts";
import { ownerAuthorizationRecord } from "../packages/community/owner-authorization-typed-data.ts";
import { requireAuthorizedOwner } from "../packages/community/owner-authorization.ts";
import { canonical, hashJson } from "../packages/community/common.ts";
import { recognitionProfile } from "../packages/recognition/intent.ts";
import { readCanonicalSource, type CanonicalSource } from "../packages/recognition/canonical-community.ts";
import { protectedPostsDbClock } from "../packages/community/protected-posts-fees.ts";
import { privateKeyToAccount } from "viem/accounts";
import { insist, jsonBody } from "../packages/community/common.ts";
import { address } from "../packages/community/manifest-core.ts";
import { megaethReadClient } from "../packages/community/chain.ts";
import { storyReadClient } from "../packages/community/registration-chain.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { ProtectedManagedClient, ProtectedManagedPin } from "../packages/community/managed-client.ts";
import type { FirstSongDriverPorts, ProtectedPostsDriverPorts } from "./first-song-driver.ts";
import { protectedFirstSongCatalog } from "./protected-first-song-catalog.ts";
import type { ProtectedCatalogTransport } from "./protected-catalog-reservation.ts";
import { protectedPostsJob, type ProtectedPostsJobTransport } from "./protected-posts-job.ts";
import { ownerOnly, catalogOwner } from "../packages/community/owner-policy.ts";
import {
  reserveOwnerBudget,
  validateOwnerGrant,
  type OwnerBudgetGrant,
} from "../packages/release/owner-grant.ts";
import { requireOwnerGrantScope } from "../packages/release/owner-release.ts";
import { firstSong } from "./first-song-profile.ts";
import { isWeb2Deployment, communityIpfsTransport, type CommunityDeploymentProfile } from "./community-deployment-profile.ts";

export interface FirstSongRuntimeEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  COMMUNITY_PUBLISHER_PRIVATE_KEY?: string;
  MANAGED_PROFILE_HASH: string;
  /** Registered release policy only. */
  CREATOR_PROFILE_HASH?: string;
  RELEASE_GRANT_HASH?: string;
  REGISTRATION_OPERATOR_ADDRESS?: string;
  POSTING_EXPIRES_AT?: string;
  /**
   * Unregistered owner policy only: the reviewed owner budget grant (the same
   * grant the managed service holds) and the controller-signed owner
   * publishing authorization.
   */
  OWNER_GRANT_JSON?: string;
  OWNER_AUTHORIZATION_JSON?: string;
  WEB2_PUBLISHING_ATTACHMENT_SHA256?: string;
  WEB2_PUBLISHING_ATTACHMENT_JSON?: string;
  WEB2_PUBLISHING_SELECTION_SHA256?: string;
  OWNER_GRANT_ADMISSION_REFERENCE?: string;
  RECOGNITION_PROFILE_JSON?: string;
  /** Reviewed existing account fence; missing input fails closed for the new policy. */
  CATALOG_ACCOUNT_FENCE?: (accountId:string,wallet:string,authorId:string)=>Promise<void>;
  CATALOG_TRANSPORT?: (request:Request)=>Promise<Response>;
  /** Trusted service binding; the configured managed origin remains the request scope. */
  MANAGED_RELEASE_SERVICE?: Fetcher;
  /** In-process local fixture selection, installed before owner Posts work. */
  LOCAL_POSTS_EFFECT_FENCE?: LocalPostsEffectFence;
}
function managedTransport(env: FirstSongRuntimeEnv) {
  return env.MANAGED_RELEASE_SERVICE
    ? (request: Request) => env.MANAGED_RELEASE_SERVICE!.fetch(request)
    : (request: Request) => fetch(request);
}
export async function managedReleaseConfigured(
  env: FirstSongRuntimeEnv, deployment: CommunityDeploymentProfile = firstSong,
) {
  try {
    const response = await managedTransport(env)(new Request(deployment.managedOrigin + "/health", {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      })),
      body = await jsonBody(response),
      release = body.release as Record<string, unknown> | undefined;
    return (
      response.ok &&
      body.profileHash === env.MANAGED_PROFILE_HASH &&
      release?.configured === true &&
      release.grantSha256 === env.RELEASE_GRANT_HASH &&
      release.registrationOperator === env.REGISTRATION_OPERATOR_ADDRESS
    );
  } catch {
    return false;
  }
}
/** The managed service reports the same owner grant, unexpired. */
export async function managedOwnerReleaseConfigured(
  env: FirstSongRuntimeEnv,
  grant: OwnerBudgetGrant,
  deployment: CommunityDeploymentProfile = firstSong,
) {
  try {
    const response = await managedTransport(env)(new Request(deployment.managedOrigin + "/health", {
        ...(env.WEB2_PUBLISHING_SELECTION_SHA256 ? {headers:{"x-pirate-community":grant.communityId,"x-pirate-owner-grant":grant.sha256}} : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      })),
      body = await jsonBody(response),
      owner = body.ownerRelease as Record<string, unknown> | undefined;
    return (
      response.ok &&
      body.profileHash === env.MANAGED_PROFILE_HASH &&
      owner?.configured === true &&
      owner.grantSha256 === grant.sha256 &&
      (!env.WEB2_PUBLISHING_SELECTION_SHA256 || (owner.selectionDigest === env.WEB2_PUBLISHING_SELECTION_SHA256 &&
        owner.admissionReference === env.OWNER_GRANT_ADMISSION_REFERENCE)) &&
      Math.floor(Date.now()/1000) >= grant.validFrom && Math.floor(Date.now()/1000) < grant.expiresAt
    );
  } catch {
    return false;
  }
}
export function publicPostsProfile(deployment: CommunityDeploymentProfile = firstSong) {
  return {
    ...deployment.posts,
    deploymentBlock: BigInt(deployment.posts.deploymentBlock),
  };
}
const postingLimits = {
  maximumGas: "1000000",
  maximumGasPrice: "30000000",
  maximumTotalFee: "30000000000000",
};
/**
 * Owner-only unregistered publication. Selected by the configuration's
 * admission policy, never by a request. There is no registration operator,
 * registration client, creator service or their health checks; readiness is
 * the managed owner release holding this same grant.
 */
function ownerSongAuthority(
  env: FirstSongRuntimeEnv,
  configuration: CommunityConfig,
  deployment: CommunityDeploymentProfile,
) {
  insist(
    env.OWNER_GRANT_JSON && env.OWNER_AUTHORIZATION_JSON,
    "owner_runtime_unconfigured",
    503,
  );
  let grant: OwnerBudgetGrant, ownerAuthorization: ReturnType<typeof ownerAuthorizationRecord>;
  try {
    grant = validateOwnerGrant(JSON.parse(env.OWNER_GRANT_JSON));
    ownerAuthorization = ownerAuthorizationRecord(JSON.parse(env.OWNER_AUTHORIZATION_JSON));
  } catch {
    insist(false, "owner_runtime_unconfigured", 503);
  }
  requireOwnerGrantScope(grant!, configuration);
  if (ownerAuthorization.authorization.schema === "pirate.owner-publishing-authorization/2") {
    insist(env.WEB2_PUBLISHING_ATTACHMENT_JSON,"web2_publishing_authority_unavailable",503);
    let attached:ReturnType<typeof publishingAttachment>;
    try {attached=publishingAttachment(JSON.parse(env.WEB2_PUBLISHING_ATTACHMENT_JSON));}
    catch {insist(false,"web2_publishing_authority_unavailable",503);}
    const scope=attached.selection.scope;
    insist(configuration.schema === "pirate.community-config/4" && attached.digest === env.WEB2_PUBLISHING_ATTACHMENT_SHA256 &&
      attached.selection.selectionDigest === env.WEB2_PUBLISHING_SELECTION_SHA256 && attached.selection.admissionReference === env.OWNER_GRANT_ADMISSION_REFERENCE &&
      canonical(attached.selection.grant) === canonical(grant!) && canonical(attached.authorization) === canonical(ownerAuthorization) &&
      scope.communityId === configuration.communityId && scope.installationId === configuration.installationId &&
      scope.origin === configuration.app.origin && scope.controller === configuration.controller && scope.publisher === configuration.publisher &&
      scope.chainId === configuration.chainId && scope.postsContract === configuration.postsContract &&
      scope.deploymentDigest === hashJson(deployment),"web2_publishing_attachment_changed",403);
    const a = ownerAuthorization.authorization;
    insist(a.communityId === grant!.communityId && a.ownerWallet === grant!.ownerWallet && canonical(a.policy) === canonical(grant!.policy) &&
      a.validFrom === grant!.validFrom && a.expiresAt === grant!.expiresAt,"owner_authorization_grant_mismatch",403);
    insist(/^0x[0-9a-f]{64}$/.test(env.WEB2_PUBLISHING_ATTACHMENT_SHA256 ?? "") &&
      /^0x[0-9a-f]{64}$/.test(env.WEB2_PUBLISHING_SELECTION_SHA256 ?? "") &&
      env.OWNER_GRANT_ADMISSION_REFERENCE,"web2_publishing_authority_unavailable",503);
  }
  return { grant, ownerAuthorization };
}

export interface ProtectedFirstSongServices {
  posts: ProtectedPostsJobTransport;
  protectedPin: ProtectedManagedPin;
  catalog: ProtectedCatalogTransport;
}

export function protectedOwnerSongRuntime(
  env: FirstSongRuntimeEnv,
  configuration: CommunityConfig,
  currentConfiguration: () => Promise<CommunityConfig>,
  deployment: CommunityDeploymentProfile,
  services: ProtectedFirstSongServices,
) {
  insist(env.COMMUNITY_PUBLISHER_PRIVATE_KEY === undefined && !env.LOCAL_POSTS_EFFECT_FENCE,
    "protected_owner_runtime_legacy_key_present", 503);
  insist(isWeb2Deployment(deployment) && configuration.schema === "pirate.community-config/4" &&
    configuration.chainId === 6343 && configuration.configurationRevision === 1 &&
    catalogOwner(configuration.policies.admission) && services.posts.installationId === configuration.installationId,
  "protected_owner_runtime_scope_unavailable", 503);
  const { grant, ownerAuthorization } = ownerSongAuthority(env, configuration, deployment);
  insist(ownerAuthorization.authorization.schema === "pirate.owner-publishing-authorization/2",
    "protected_owner_authorization_unavailable", 503);
  insist(env.RECOGNITION_PROFILE_JSON &&
    canonical(recognitionProfile(JSON.parse(env.RECOGNITION_PROFILE_JSON))) === canonical(configuration.policies.recognition),
  "recognition_pin_changed", 503);
  const managed: ProtectedManagedClient = {
    origin: deployment.managedOrigin, configuration, protectedPin: services.protectedPin,
  };
  insist(env.CATALOG_ACCOUNT_FENCE, "protected_owner_account_fence_unavailable", 503);
  const ownerVerification = {
    client: megaethReadClient(undefined, deployment.rpcUrl), currentConfiguration,
    now: () => Math.floor(Date.now() / 1000), maxSafeBlockAgeSeconds: BigInt(deployment.freshness.maxSafeBlockAgeSeconds),
  };
  const readPorts = {
    db: env.DB, media: env.MEDIA, currentConfiguration, currentAccount: env.CATALOG_ACCOUNT_FENCE,
    ownerAuthorization: async () => ownerAuthorization, ownerVerification,
  };
  const catalog = protectedFirstSongCatalog(readPorts, services.catalog);
  const runtime: FirstSongDriverPorts<ProtectedPostsDriverPorts> = {
    db: env.DB, media: env.MEDIA, managed, ownerAuthorization,
    release: { client: managed, grantHash: grant.sha256, ownerGrant: grant, ipfs: communityIpfsTransport(deployment) },
    posting: {
      ownerGrant: grant, profile: publicPostsProfile(deployment), config: configuration,
      bounds: { period: `owner-${grant.validFrom}-${grant.expiresAt}`, ...postingLimits, expiresAt: grant.expiresAt },
      protectedPosts: protectedPostsJob({ db: env.DB, ownerGrant: grant, maximumTotalFee: postingLimits.maximumTotalFee }, services.posts),
    },
    protectedCatalog: catalog.operation,
    acrEndpoint: "https://identify-eu-west-1.acrcloud.com/v1/identify",
    ownerVerification,
    async checkServices() {
      insist(await managedOwnerReleaseConfigured(env, grant, deployment), "release_service_unavailable", 503);
    },
  };
  const authorize = async (source: CanonicalSource, operationId: string, expiresAtMs: number, signal: AbortSignal) => {
    await readCanonicalSource(readPorts, source);
    requireOwnerGrantScope(grant, await currentConfiguration());
    await reserveOwnerBudget(env.DB, grant, "recognition_requests", operationId, hashJson(source), "1", undefined, async () => {
      const owner = await requireAuthorizedOwner(ownerAuthorization, configuration, grant.ownerWallet, undefined, ownerVerification);
      signal.throwIfAborted();
      insist(Date.now() < expiresAtMs, "canonical_request_scope_changed", 403);
      return {
        clause: `unixepoch()>=? AND unixepoch()<? AND ?>${protectedPostsDbClock}`,
        binds: [Math.max(owner.validFrom, grant.validFrom), Math.min(owner.expiresAt, grant.expiresAt), expiresAtMs],
        code: "owner_authorization_outside_window",
      };
    });
    await readCanonicalSource(readPorts, source);
  };
  return { runtime, configuration, maximumTotalFee: postingLimits.maximumTotalFee, catalogReady: catalog.ready, authorize };
}

export function ownerSongRuntime(
  env: FirstSongRuntimeEnv,
  configuration: CommunityConfig,
  currentConfiguration: () => Promise<CommunityConfig>,
  managedReady: (grant: OwnerBudgetGrant) => Promise<boolean> = (grant) =>
    managedOwnerReleaseConfigured(env, grant, deployment),
  deployment: CommunityDeploymentProfile = firstSong,
): FirstSongDriverPorts {
  insist(/^0x[0-9a-fA-F]{64}$/.test(env.COMMUNITY_PUBLISHER_PRIVATE_KEY ?? ""), "owner_runtime_unconfigured", 503);
  const { grant, ownerAuthorization } = ownerSongAuthority(env, configuration, deployment);
  const publisher = privateKeyToAccount(
      env.COMMUNITY_PUBLISHER_PRIVATE_KEY as `0x${string}`,
    ),
    managed = { origin: deployment.managedOrigin, publisher, configuration, transport: managedTransport(env) };
  insist(publisher.address.toLowerCase() === configuration.publisher,"publisher_custody_binding_changed",503);
  const localPostsFence = env.LOCAL_POSTS_EFFECT_FENCE;
  if (localPostsFence) {
    insist(isWeb2Deployment(deployment), "local_posts_custody_scope_changed", 409);
    localPostsFence.assertApplicationRpc(deployment.rpcUrl);
    localPostsFence.assertScope(env.DB, configuration, publisher.address);
  }
  const managedChainClient = megaethReadClient(undefined, deployment.rpcUrl);
  const runtime: FirstSongDriverPorts = {
    db: env.DB,
    media: env.MEDIA,
    managed,
    release: { client: managed, grantHash: grant!.sha256, ownerGrant: grant!, ipfs: communityIpfsTransport(deployment) },
    posting: {
      db: env.DB,
      client: managedChainClient,
      publisher,
      profile: publicPostsProfile(deployment),
      config: configuration,
      currentConfiguration,
      ownerReservationCondition:async()=>{
        const owner=await requireAuthorizedOwner(ownerAuthorization,configuration,grant!.ownerWallet,undefined,runtime.ownerVerification);
        return {clause:"unixepoch()>=? AND unixepoch()<?",binds:[Math.max(owner.validFrom,grant!.validFrom),Math.min(owner.expiresAt,grant!.expiresAt)],code:"owner_authorization_outside_window"};
      },
      beforeBroadcast:async()=>{await requireAuthorizedOwner(ownerAuthorization,configuration,grant!.ownerWallet,undefined,runtime.ownerVerification);},
      bounds: {
        period: `owner-${grant!.validFrom}-${grant!.expiresAt}`,
        ...postingLimits,
        expiresAt: grant!.expiresAt,
      },
      ownerGrant: grant!,
      ...(localPostsFence ? { localPostsFence } : {}),
    },
    acrEndpoint: "https://identify-eu-west-1.acrcloud.com/v1/identify",
    ownerAuthorization,
    ownerVerification: isWeb2Deployment(deployment) ? {
      client: managedChainClient, currentConfiguration,
      now: () => Math.floor(Date.now() / 1000),
      maxSafeBlockAgeSeconds: BigInt(deployment.freshness.maxSafeBlockAgeSeconds),
    } : undefined,
    async checkServices() {
      insist(await managedReady(grant!), "release_service_unavailable", 503);
    },
  };
  if (catalogOwner(configuration.policies.admission)) {
    insist(env.RECOGNITION_PROFILE_JSON && env.CATALOG_ACCOUNT_FENCE,"recognition_runtime_unconfigured",503);
    insist(configuration.communityId===deployment.directoryProfile.communityId&&configuration.app.origin===deployment.origin&&
      configuration.postsContract===deployment.posts.address && configuration.directory===deployment.directoryProfile.directory &&
      (isWeb2Deployment(deployment)
        ? configuration.schema==="pirate.community-config/4" && configuration.communityKey===deployment.directoryProfile.communityKey &&
          configuration.installationId===deployment.directoryProfile.installationId && configuration.chainId===deployment.directoryProfile.chainId
        : configuration.schema!=="pirate.community-config/4" && configuration.registry===deployment.directoryProfile.registry),
      "recognition_deployment_profile_changed",503);
    const pin=recognitionProfile(JSON.parse(env.RECOGNITION_PROFILE_JSON));
    insist(canonical(pin)===canonical(configuration.policies.recognition) && pin.signer!==grant!.ownerWallet,"recognition_pin_changed",503);
    runtime.catalog={db:env.DB,media:env.MEDIA,currentConfiguration,ownerAuthorization:async()=>ownerAuthorization,ownerVerification:runtime.ownerVerification,
      publicIpfs:communityIpfsTransport(deployment),
      posting:runtime.posting,publisher,transport:env.CATALOG_TRANSPORT,
      beforeCatalogDispatch:async(_operation,finalFence)=>{
        const owner=await requireAuthorizedOwner(ownerAuthorization,configuration,grant!.ownerWallet,undefined,runtime.ownerVerification);
        await finalFence();
        const now=Math.floor(Date.now()/1000);
        insist(now>=owner.validFrom&&now<owner.expiresAt,"owner_authorization_outside_window",403);
      },currentAccount:env.CATALOG_ACCOUNT_FENCE,
      authorizeRecognition:async(id,request)=>{requireOwnerGrantScope(grant!,await currentConfiguration());await reserveOwnerBudget(env.DB,grant!,"recognition_requests",id,request,"1",undefined,async()=>{
        const owner=await requireAuthorizedOwner(ownerAuthorization,configuration,grant!.ownerWallet,undefined,runtime.ownerVerification);
        return {clause:"unixepoch()>=? AND unixepoch()<?",binds:[Math.max(owner.validFrom,grant!.validFrom),Math.min(owner.expiresAt,grant!.expiresAt)],code:"owner_authorization_outside_window"};
      });await requireAuthorizedOwner(ownerAuthorization,configuration,grant!.ownerWallet,undefined,runtime.ownerVerification);}};
  }
  return runtime;
}
export function firstSongRuntime(
  env: FirstSongRuntimeEnv,
  configuration: CommunityConfig,
  currentConfiguration: () => Promise<CommunityConfig>,
  deployment: CommunityDeploymentProfile = firstSong,
): FirstSongDriverPorts {
  if (ownerOnly(configuration.policies.admission))
    return ownerSongRuntime(env, configuration, currentConfiguration, undefined, deployment);
  insist(!env.LOCAL_POSTS_EFFECT_FENCE && !isWeb2Deployment(deployment) && configuration.schema!=="pirate.community-config/4",
    "historical_registered_release_profile_required", 503);
  insist(
    /^0x[0-9a-fA-F]{64}$/.test(env.COMMUNITY_PUBLISHER_PRIVATE_KEY ?? "") &&
      /^0x[0-9a-f]{64}$/.test(env.RELEASE_GRANT_HASH ?? ""),
    "release_runtime_unconfigured",
    503,
  );
  const publisher = privateKeyToAccount(
      env.COMMUNITY_PUBLISHER_PRIVATE_KEY as `0x${string}`,
    ),
    client = megaethReadClient(undefined, deployment.rpcUrl),
    story = storyReadClient(),
    managed = { origin: deployment.managedOrigin, publisher, configuration },
    expiresAt = Number(env.POSTING_EXPIRES_AT);
  insist(
    Number.isSafeInteger(expiresAt) && expiresAt > 0,
    "release_runtime_unconfigured",
    503,
  );
  return {
    db: env.DB,
    media: env.MEDIA,
    managed,
    release: {
      client: managed,
      grantHash: env.RELEASE_GRANT_HASH!,
      registrationOperator: address(env.REGISTRATION_OPERATOR_ADDRESS),
      story,
      ipfs: communityIpfsTransport(deployment),
    },
    posting: {
      db: env.DB,
      client,
      publisher,
      profile: publicPostsProfile(deployment),
      config: configuration,
      currentConfiguration,
      bounds: {
        period: deployment.postingPeriod,
        ...postingLimits,
        expiresAt,
      },
    },
    acrEndpoint: "https://identify-eu-west-1.acrcloud.com/v1/identify",
    async checkServices() {
      const native = await fetch(deployment.creatorOrigin + "/api/health", {
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        }),
        status = await jsonBody(native);
      insist(
        native.ok &&
          status.profileHash === env.CREATOR_PROFILE_HASH &&
          status.testnet === true &&
          (await managedReleaseConfigured(env, deployment)),
        "release_service_unavailable",
        503,
      );
    },
  };
}
