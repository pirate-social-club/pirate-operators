import type { Address, Hex } from "viem";
import {
  canonical,
  exact,
  hashText,
  insist,
  integer,
  object,
  text,
} from "./common.ts";
import {
  address,
  chain,
  httpsOrigin,
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
} from "./manifest-core.ts";
import { ownerCurated, unregisteredOwner } from "./owner-policy.ts";
import { directoryInstanceId, sharedBytes32 } from "./shared-identity.ts";
import {
  validateWeb2Profile,
  type Web2DirectoryProfile,
} from "./web2-directory.ts";
import type { PublisherRevocation } from "./config-manifest.ts";

export interface Web2CommunityConfig {
  schema: "pirate.community-config/3";
  chainId: 6343 | 31337;
  directory: Address;
  communityId: Hex;
  communityKey: Hex;
  installationId: Hex;
  configurationRevision: number;
  postsContract: Address;
  controller: Address;
  publisher: Address;
  operatorPayments: Address;
  learningRecords: Address;
  app: { label: string; origin: string };
  feed: { endpoint: string; signingKeyId: string };
  policies: {
    admission: { version: string; sha256: Hex };
    moderationSigner: Address;
  };
  publisherRevocations: PublisherRevocation[];
}
export function parseWeb2Configuration(value: unknown): Web2CommunityConfig {
  const o = object(value);
  exact(o, [
    "schema",
    "chainId",
    "directory",
    "communityId",
    "communityKey",
    "installationId",
    "configurationRevision",
    "postsContract",
    "controller",
    "publisher",
    "operatorPayments",
    "learningRecords",
    "app",
    "feed",
    "policies",
    "publisherRevocations",
  ]);
  insist(
    o.schema === "pirate.community-config/3",
    "wrong_configuration_schema",
  );
  const app = object(o.app),
    feed = object(o.feed),
    policies = object(o.policies),
    admission = object(policies.admission);
  exact(app, ["label", "origin"]);
  exact(feed, ["endpoint", "signingKeyId"]);
  exact(policies, ["admission", "moderationSigner"]);
  exact(admission, ["version", "sha256"]);
  const policy = {
    version: text(admission.version, 128),
    sha256: sharedBytes32(admission.sha256),
  };
  insist(
    (policy.version === RELEASE_POLICY &&
      policy.sha256 === RELEASE_POLICY_HASH) ||
      ownerCurated(policy) ||
      unregisteredOwner(policy),
    "unsupported_admission_policy",
  );
  const origin = httpsOrigin(app.origin),
    label = text(app.label, 63),
    chainId = chain(o.chainId),
    key = sharedBytes32(o.communityKey);
  insist(
    label.trim().length > 0 && feed.endpoint === origin + "/api/feed",
    "invalid_web2_application",
  );
  insist(
    o.communityId === directoryInstanceId(chainId, key),
    "community_identity_mismatch",
  );
  insist(Array.isArray(o.publisherRevocations), "invalid_revocations");
  const revocations = o.publisherRevocations.map((value) => {
    const r = object(value);
    exact(r, ["postsContract", "publisher", "fromBlock"]);
    insist(
      typeof r.fromBlock === "string" &&
        /^(0|[1-9][0-9]{0,77})(?![\s\S])/.test(r.fromBlock),
      "invalid_revocation_block",
    );
    return {
      postsContract: address(r.postsContract),
      publisher: address(r.publisher),
      fromBlock: r.fromBlock,
    };
  });
  return {
    schema: "pirate.community-config/3",
    chainId,
    directory: address(o.directory),
    communityKey: key,
    communityId: sharedBytes32(o.communityId),
    installationId: sharedBytes32(o.installationId),
    configurationRevision: integer(
      o.configurationRevision,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    postsContract: address(o.postsContract),
    controller: address(o.controller),
    publisher: address(o.publisher),
    operatorPayments: address(o.operatorPayments, true),
    learningRecords: address(o.learningRecords, true),
    app: { label, origin },
    feed: {
      endpoint: origin + "/api/feed",
      signingKeyId: text(feed.signingKeyId, 128),
    },
    policies: {
      admission: policy,
      moderationSigner: address(policies.moderationSigner),
    },
    publisherRevocations: revocations,
  };
}
export function validateWeb2Configuration(
  value: unknown,
  profile: Web2DirectoryProfile,
): Web2CommunityConfig {
  const p = validateWeb2Profile(profile),
    c = parseWeb2Configuration(value);
  insist(
    c.chainId === p.chainId &&
      c.directory === p.directory &&
      c.communityId === p.communityId &&
      c.communityKey === p.communityKey &&
      c.installationId === p.installationId,
    "configuration_profile_mismatch",
  );
  return c;
}
export function assertWeb2Origin(
  config: Web2CommunityConfig,
  origin: { sha256Digest: Hex },
) {
  insist(
    hashText(config.app.origin) === origin.sha256Digest,
    "configuration_origin_mismatch",
    503,
  );
}
export interface Web2ConfigurationState {
  first?: Web2CommunityConfig;
  last?: Web2CommunityConfig;
  publishers: Set<string>;
  revocations: Set<string>;
}
export const web2ConfigurationState = (): Web2ConfigurationState => ({
  publishers: new Set(),
  revocations: new Set(),
});
export function advanceWeb2Configuration(
  state: Web2ConfigurationState,
  c: Web2CommunityConfig,
  atBlock: bigint,
) {
  insist(
    c.configurationRevision === (state.last?.configurationRevision ?? 0) + 1,
    "configuration_history_required",
  );
  const first = state.first;
  if (first)
    insist(
      first.chainId === c.chainId &&
        first.directory === c.directory &&
        first.communityId === c.communityId &&
        first.communityKey === c.communityKey &&
        first.installationId === c.installationId &&
        first.postsContract === c.postsContract,
      "wrong_configuration_history",
    );
  const revocations = new Set(c.publisherRevocations.map(canonical));
  insist(
    revocations.size === c.publisherRevocations.length,
    "duplicate_revocation",
  );
  for (const old of state.revocations)
    insist(revocations.has(old), "revocation_removed_or_changed");
  for (const revoked of c.publisherRevocations)
    insist(
      BigInt(revoked.fromBlock) <= atBlock &&
        state.publishers.has(revoked.publisher) &&
        revoked.publisher !== c.publisher &&
        revoked.postsContract === c.postsContract,
      "invalid_publisher_revocation",
    );
  state.first ??= c;
  state.last = c;
  state.publishers.add(c.publisher);
  state.revocations = revocations;
  return c;
}
