import type { Address, Hex } from "viem";
import { ownerCurated, unregisteredOwner } from "./owner-policy.ts";
import {
  bytes32,
  canonical,
  exact,
  insist,
  integer,
  object,
  text,
} from "./common.ts";
import {
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
  address,
  chain,
  communityId,
  decimal,
  httpsOrigin,
  schema,
} from "./manifest-core.ts";

export interface PublisherRevocation {
  postsContract: Address;
  publisher: Address;
  fromBlock: string;
}
export interface CommunityConfig {
  schema: "pirate.community-config/1";
  chainId: number;
  directory: Address;
  communityId: Hex;
  registry: Address;
  tld: string;
  configurationRevision: number;
  postsContract: Address;
  controller: Address;
  publisher: Address;
  operatorPayments: Address;
  learningRecords: Address;
  app: {
    label: string;
    tokenGeneration: "0";
    origin: string;
    httpsAlias: string | null;
    hnsIngress: "none";
  };
  feed: { endpoint: string; signingKeyId: string };
  policies: {
    admission: { version: string; sha256: Hex };
    moderationSigner: Address;
  };
  publisherRevocations: PublisherRevocation[];
}
export function validateConfig(
  value: unknown,
  previous: CommunityConfig[] = [],
  atBlock?: bigint,
): CommunityConfig {
  const o = schema(value, "pirate.community-config/1", [
    "chainId",
    "directory",
    "communityId",
    "registry",
    "tld",
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
  const app = object(o.app),
    feed = object(o.feed),
    policies = object(o.policies);
  exact(app, [
    "label",
    "tokenGeneration",
    "origin",
    "httpsAlias",
    "hnsIngress",
  ]);
  exact(feed, ["endpoint", "signingKeyId"]);
  exact(policies, ["admission", "moderationSigner"]);
  const admission = object(policies.admission);
  exact(admission, ["version", "sha256"]);
  insist(
    (admission.version === RELEASE_POLICY &&
      admission.sha256 === RELEASE_POLICY_HASH) ||
      ownerCurated(admission as { version: string; sha256: string }) ||
      unregisteredOwner(admission as { version: string; sha256: string }),
    "unsupported_admission_policy",
  );
  const tld = text(o.tld, 63),
    label = text(app.label, 63);
  insist(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tld) &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    "invalid_label",
  );
  insist(
    app.tokenGeneration === "0" && app.hnsIngress === "none",
    "native_address_profile_not_supported",
  );
  const origin = httpsOrigin(app.origin);
  const alias = app.httpsAlias === null ? null : httpsOrigin(app.httpsAlias);
  const endpoint = text(feed.endpoint, 1024);
  insist(endpoint === origin + "/api/feed", "wrong_feed_origin");
  const registry = address(o.registry),
    chainId = chain(o.chainId),
    id = bytes32(o.communityId);
  insist(id === communityId(chainId, registry), "community_identity_mismatch");
  insist(
    Array.isArray(o.publisherRevocations) &&
      o.publisherRevocations.length <= 256,
    "invalid_revocations",
  );
  const revocations = o.publisherRevocations.map((value) => {
    const r = object(value);
    exact(r, ["postsContract", "publisher", "fromBlock"]);
    return {
      postsContract: address(r.postsContract),
      publisher: address(r.publisher),
      fromBlock: decimal(r.fromBlock),
    };
  });
  const result: CommunityConfig = {
    schema: "pirate.community-config/1",
    chainId,
    directory: address(o.directory),
    communityId: id,
    registry,
    tld,
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
    app: {
      label,
      tokenGeneration: "0",
      origin,
      httpsAlias: alias,
      hnsIngress: "none",
    },
    feed: { endpoint, signingKeyId: text(feed.signingKeyId, 128) },
    policies: {
      admission: {
        version: String(admission.version),
        sha256: bytes32(admission.sha256),
      },
      moderationSigner: address(policies.moderationSigner),
    },
    publisherRevocations: revocations,
  };
  insist(
    previous.length === result.configurationRevision - 1 &&
      previous.every((p, i) => p.configurationRevision === i + 1),
    "configuration_history_required",
  );
  for (const old of previous) {
    insist(
      old.chainId === chainId &&
        old.directory === result.directory &&
        old.communityId === id &&
        old.registry === registry &&
        old.tld === tld &&
        old.postsContract === result.postsContract &&
        old.configurationRevision < result.configurationRevision,
      "wrong_configuration_history",
    );
    for (const revoked of old.publisherRevocations)
      insist(
        revocations.some((r) => canonical(r) === canonical(revoked)),
        "revocation_removed_or_changed",
      );
  }
  for (const revoked of revocations) {
    insist(
      atBlock !== undefined && BigInt(revoked.fromBlock) <= atBlock,
      "invalid_revocation_block",
    );
    insist(
      previous.some((p) => p.publisher === revoked.publisher),
      "unknown_revoked_publisher",
    );
    insist(revoked.publisher !== result.publisher, "publisher_is_revoked");
  }
  return result;
}
