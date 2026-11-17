import type { PublicClient } from "viem";
import { canonical, insist } from "../packages/community/common.ts";
import { ensureCommunityIdentity } from "../packages/community/accounts.ts";
import type { IpfsTransport } from "../packages/community/ipfs.ts";
import type { Web2DirectoryProfile } from "../packages/community/web2-directory.ts";
import {
  readWeb2Community,
  type Web2EligibilityPolicy,
} from "../packages/community/web2-directory-reader.ts";

/** Persist only a completed authenticated Directory/IPFS read. The stored row
 * records the original configuration event, not the later verification head.
 * Cache conflict is an explicit public hold; this producer never overwrites
 * another incarnation or treats cached bytes as fresh chain authority. */
export async function readAndCacheWeb2Configuration(input: {
  db: D1Database;
  client: PublicClient;
  profile: Web2DirectoryProfile;
  policy: Web2EligibilityPolicy;
  transport?: IpfsTransport;
  origin: string;
}) {
  const origin = input.origin;
  const read = await readWeb2Community(
    input.client,
    input.profile,
    input.policy,
    input.transport,
  );
  insist(
    read.eligibility.status === "available",
    "community_authority_unavailable",
    503,
  );
  insist(
    read.config.app.origin === origin,
    "community_configuration_changed",
    503,
  );
  const { document, log } = read.configurationEvidence;
  const row = {
    community_id: read.config.communityId,
    revision: read.config.configurationRevision,
    publisher: read.config.publisher,
    manifest_uri: log.args.uri,
    manifest_sha256: log.args.sha256Digest,
    manifest_json: document,
    block_number: String(log.blockNumber),
    block_hash: log.blockHash,
    transaction_hash: log.transactionHash,
  };
  await ensureCommunityIdentity(input.db, {
    communityId: read.config.communityId,
    origin,
  });
  await input.db.batch([
    input.db
      .prepare(
        `INSERT INTO public_configurations
      (community_id,revision,publisher,manifest_uri,manifest_sha256,manifest_json,block_number,block_hash,transaction_hash)
      SELECT ?,?,?,?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)
      AND NOT EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision>?)
      ON CONFLICT(community_id,revision) DO NOTHING`,
      )
      .bind(
        row.community_id,
        row.revision,
        row.publisher,
        row.manifest_uri,
        row.manifest_sha256,
        row.manifest_json,
        row.block_number,
        row.block_hash,
        row.transaction_hash,
        row.community_id,
        origin,
        row.community_id,
        row.revision,
      ),
  ]);
  const stored = await input.db
    .prepare(
      `SELECT community_id,revision,publisher,manifest_uri,manifest_sha256,manifest_json,
    block_number,block_hash,transaction_hash FROM public_configurations WHERE community_id=? AND revision=?
    AND EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)
    AND NOT EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision>?)`,
    )
    .bind(
      row.community_id,
      row.revision,
      row.community_id,
      origin,
      row.community_id,
      row.revision,
    )
    .first();
  insist(
    stored && canonical(stored) === canonical(row),
    "web2_configuration_cache_changed",
    503,
  );
  return read;
}
