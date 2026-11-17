/** Root-owned initialization join after pure private-policy validation and
 * genuine Directory verification. Reads an EXISTING verified configuration
 * cache; never fabricates/provisions its event/URI/block evidence or authority. */
import {
  bytes32,
  canonical,
  hashJson,
  hashText,
  insist,
  integer,
} from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { DanceStore } from "../packages/dance/store.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import type { DancePrivatePolicyV2 } from "./dance-private-catalogue.ts";

interface ContextRow {
  revision: number;
  body_json: string;
}
interface ConfigurationRow {
  publisher: string;
  manifest_sha256: string;
  manifest_json: string;
  manifest_uri: string;
  block_number: string;
  block_hash: string;
  transaction_hash: string;
}
export interface PreparedPrivateDanceState {
  communityId: string;
  revision: number;
  bodyJson: string;
  policyHash: string;
}
export async function preparePrivateDanceState(input: {
  db: D1Database;
  config: CommunityConfig;
  policy: DancePrivatePolicyV2;
  policyHash: string;
  /** Throw on lost/changed Root-selected profile or fresh configuration. This
   * check supplies no public grant, account, song or provider permission. */
  current(): void | Promise<void>;
}): Promise<PreparedPrivateDanceState> {
  const db = input.db,
    config = structuredClone(input.config),
    policy = structuredClone(input.policy),
    current = input.current;
  const communityId = bytes32(config.communityId),
    revision = integer(
      config.configurationRevision,
      1,
      Number.MAX_SAFE_INTEGER,
    );
  const policyHash = bytes32(input.policyHash),
    configJson = canonical(config),
    policyJson = canonical(policy);
  insist(
    policy.version === "pirate.dance-private-policy/2" &&
      policy.configurationRevision === revision &&
      policy.consent.admission === "admitted" &&
      hashJson(policy) === policyHash,
    "dance_private_policy_changed",
    409,
  );
  let invalid = false;
  function sameSelection() {
    if (
      input.db !== db ||
      input.current !== current ||
      input.policyHash !== policyHash ||
      canonical(input.config) !== configJson ||
      canonical(input.policy) !== policyJson
    )
      invalid = true;
    insist(!invalid, "dance_private_selection_changed", 409);
  }
  async function check() {
    sameSelection();
    await current();
    sameSelection();
  }
  const store = new DanceStore(db);
  await check();
  const identity = await db
    .prepare(
      "SELECT community_id,community_origin FROM application_identity WHERE id=1",
    )
    .first<{ community_id: string; community_origin: string }>();
  await check();
  insist(
    identity?.community_id === communityId &&
      identity.community_origin === config.app.origin,
    "dance_private_application_identity_changed",
    503,
  );
  const configuration = await db
    .prepare(
      `SELECT publisher,manifest_sha256,manifest_json,manifest_uri,block_number,block_hash,transaction_hash
    FROM public_configurations WHERE community_id=? AND revision=?`,
    )
    .bind(communityId, revision)
    .first<ConfigurationRow>();
  await check();
  insist(
    configuration &&
      configuration.manifest_json === configJson &&
      configuration.manifest_sha256 === hashText(configJson) &&
      configuration.publisher === config.publisher,
    "dance_private_configuration_missing",
    503,
  );
  const later = await db
    .prepare(
      "SELECT revision FROM public_configurations WHERE community_id=? AND revision>? LIMIT 1",
    )
    .bind(communityId, revision)
    .first();
  await check();
  insist(!later, "dance_private_configuration_changed", 409);
  const original = await db
    .prepare(
      "SELECT revision,body_json FROM dance_host_context WHERE community_id=?",
    )
    .bind(communityId)
    .first<ContextRow>();
  await check();
  function matching(row: ContextRow) {
    integer(row.revision, 1, Number.MAX_SAFE_INTEGER);
    const value: unknown = JSON.parse(row.body_json);
    insist(
      value &&
        typeof value === "object" &&
        "version" in value &&
        value.version === "pirate.dance-private-policy/2" &&
        canonical(value) === policyJson &&
        hashJson(value) === policyHash,
      "dance_private_policy_changed",
      409,
    );
  }
  if (original) matching(original);
  const fences: DanceFence[] = [
    {
      sql: "EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)",
      values: [communityId, config.app.origin],
    },
    // Preserve the genuine cache's full observed incarnation. Only Root's
    // verified producer may write these event/URI/block/transaction facts.
    {
      sql: `EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision=? AND publisher=?
      AND manifest_sha256=? AND manifest_json=? AND manifest_uri=? AND block_number=? AND block_hash=? AND transaction_hash=?)
      AND NOT EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision>?)`,
      values: [
        communityId,
        revision,
        configuration.publisher,
        configuration.manifest_sha256,
        configuration.manifest_json,
        configuration.manifest_uri,
        configuration.block_number,
        configuration.block_hash,
        configuration.transaction_hash,
        communityId,
        revision,
      ],
    },
    original
      ? {
          sql: "EXISTS(SELECT 1 FROM dance_host_context WHERE community_id=? AND revision=? AND body_json=?)",
          values: [communityId, original.revision, original.body_json],
        }
      : {
          sql: "NOT EXISTS(SELECT 1 FROM dance_host_context WHERE community_id=?) OR EXISTS(SELECT 1 FROM dance_host_context WHERE community_id=? AND body_json=?)",
          values: [communityId, communityId, policyJson],
        },
  ];
  const insert = db
    .prepare(
      `INSERT INTO dance_host_context(community_id,revision,body_json)
    SELECT ?,1,? WHERE NOT EXISTS(SELECT 1 FROM dance_host_context WHERE community_id=?)`,
    )
    .bind(communityId, policyJson, communityId);
  await check();
  // Guards and the conditional insert share the existing native D1 transaction.
  // Matching concurrent activation may win; never overwrite/reset its row.
  await store.atomic(fences, original ? [] : [insert]);
  await check();
  const saved = await db
    .prepare(
      "SELECT revision,body_json FROM dance_host_context WHERE community_id=?",
    )
    .bind(communityId)
    .first<ContextRow>();
  await check();
  insist(saved, "dance_private_policy_missing", 503);
  matching(saved);
  return {
    communityId,
    revision: saved.revision,
    bodyJson: saved.body_json,
    policyHash,
  };
}
