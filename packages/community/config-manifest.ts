import type { Address, Hex } from "viem";
import { canonicalTld, directoryInstanceId, sharedBytes32, sharedNamespaceId } from "./shared-identity.ts";
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
export interface LegacyCommunityConfig {
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
export interface SharedCommunityConfig extends Omit<LegacyCommunityConfig, "schema"> {
  schema: "pirate.community-config/2";
  communityKey: Hex;
  installationId: Hex;
  namespaceId: Hex;
  registryCodeHash: Hex;
  registrySourceCommit: string;
  registryAbiSha256: Hex;
}
export type CommunityConfig = LegacyCommunityConfig | SharedCommunityConfig;
export type DirectoryConfig = CommunityConfig;
export interface ConfigurationState {
  first?: DirectoryConfig;
  last?: DirectoryConfig;
  publishers: Set<string>;
  revocations: Set<string>;
}
export const configurationState = (): ConfigurationState => ({
  publishers: new Set(), revocations: new Set(),
});
export function parseConfiguration(value: unknown): DirectoryConfig {
  const raw = object(value), shared = raw.schema === "pirate.community-config/2";
  const o = schema(value, shared ? "pirate.community-config/2" : "pirate.community-config/1", [
    "chainId", "directory", "communityId", "registry", "tld", "configurationRevision",
    "postsContract", "controller", "publisher", "operatorPayments", "learningRecords",
    "app", "feed", "policies", "publisherRevocations",
    ...(shared ? ["communityKey", "installationId", "namespaceId", "registryCodeHash", "registrySourceCommit", "registryAbiSha256"] : []),
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
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?![\s\S])/.test(tld) &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?![\s\S])/.test(label),
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
  if (shared) {
    canonicalTld(tld);
    insist(id === directoryInstanceId(chainId, sharedBytes32(o.communityKey)) &&
      o.namespaceId === sharedNamespaceId(tld), "community_identity_mismatch");
  } else insist(id === communityId(chainId, registry), "community_identity_mismatch");
  insist(
    Array.isArray(o.publisherRevocations),
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
  const result: LegacyCommunityConfig = {
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
  if (!shared) return result;
  insist(typeof o.registrySourceCommit === "string" &&
    /^[0-9a-f]{40}(?![\s\S])/.test(o.registrySourceCommit), "invalid_registry_source_commit");
  return { ...result, schema: "pirate.community-config/2",
    communityKey: sharedBytes32(o.communityKey), installationId: sharedBytes32(o.installationId),
    namespaceId: sharedBytes32(o.namespaceId), registryCodeHash: sharedBytes32(o.registryCodeHash),
    registrySourceCommit: o.registrySourceCommit, registryAbiSha256: sharedBytes32(o.registryAbiSha256) };
}

// State is reconstructed from authenticated history, never trusted from stored JSON.
export function advanceConfiguration(state: ConfigurationState, result: DirectoryConfig, atBlock?: bigint) {
  insist(result.configurationRevision === (state.last?.configurationRevision ?? 0) + 1,
    "configuration_history_required");
  const old = state.first;
  if (old) {
    insist(old.schema === result.schema && old.chainId === result.chainId &&
      old.directory === result.directory && old.communityId === result.communityId &&
      old.registry === result.registry && old.tld === result.tld &&
      old.postsContract === result.postsContract, "wrong_configuration_history");
    if (old.schema === "pirate.community-config/2" && result.schema === "pirate.community-config/2") {
      insist(old.communityKey === result.communityKey && old.installationId === result.installationId &&
        old.namespaceId === result.namespaceId && old.registryCodeHash === result.registryCodeHash &&
        old.registrySourceCommit === result.registrySourceCommit && old.registryAbiSha256 === result.registryAbiSha256 &&
        old.app.origin === result.app.origin, "shared_binding_changed");
    }
  }
  const revocations = new Set(result.publisherRevocations.map(canonical));
  insist(revocations.size === result.publisherRevocations.length, "duplicate_revocation");
  for (const revoked of state.revocations)
    insist(revocations.has(revoked), "revocation_removed_or_changed");
  for (const revoked of result.publisherRevocations) {
    insist(atBlock !== undefined && BigInt(revoked.fromBlock) <= atBlock, "invalid_revocation_block");
    insist(state.publishers.has(revoked.publisher), "unknown_revoked_publisher");
    insist(revoked.publisher !== result.publisher, "publisher_is_revoked");
    insist(revoked.postsContract === result.postsContract, "wrong_revocation_contract");
  }
  state.first ??= result;
  state.last = result;
  state.publishers.add(result.publisher);
  state.revocations = revocations;
  return result;
}
export function validateConfiguration(value: unknown, state: ConfigurationState, atBlock?: bigint): DirectoryConfig {
  return advanceConfiguration(state, parseConfiguration(value), atBlock);
}
export function validateConfig(value: unknown, previous: CommunityConfig[] = [], atBlock?: bigint): LegacyCommunityConfig {
  const state = configurationState();
  for (const old of previous) advanceConfiguration(state, old, atBlock);
  const result = validateConfiguration(value, state, atBlock);
  insist(result.schema === "pirate.community-config/1", "wrong_configuration_schema");
  return result;
}
