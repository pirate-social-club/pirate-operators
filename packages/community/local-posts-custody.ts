import type { Address, Hex, PublicClient } from "viem";
import { canonical, hashJson, insist } from "./common.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import type { ExternalOperation, PublicationJob } from "./publication-store.ts";

export interface LocalPostsScope {
  readonly chainId: 6343;
  readonly genesisHash: Hex;
  readonly rpcUrl: string;
  // Present only when the signed native fixture graph maps this exact app
  // endpoint to the same disposable chain used by the direct Node reader.
  readonly native?: Readonly<{ applicationRpcUrl: string; fixtureTransportSha256: Hex }>;
  readonly publisher: Address;
  readonly installationId: string;
  readonly communityId: Hex;
  readonly origin: string;
}

export const POSTS_DB_CLOCK = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/** Local host migration only, before the owning Posts runtime can acquire work.
 * The trigger covers normal leaseJob UPDATE even with an older captured job. */
export const LOCAL_POSTS_CUSTODY_SCHEMA = [
  `CREATE TABLE local_posts_custody(
    slot INTEGER PRIMARY KEY CHECK(slot=1),
    scope_key TEXT NOT NULL UNIQUE, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
    state TEXT NOT NULL CHECK(state IN ('posts','draining','held','reconcile')),
    holder TEXT,
    snapshot_sha256 TEXT, safe_block TEXT, safe_hash TEXT,
    CHECK((state='posts' AND holder IS NULL) OR (state<>'posts' AND holder IS NOT NULL))
  )`,
  `CREATE TABLE local_posts_effects(
    operation_id TEXT PRIMARY KEY REFERENCES external_operations(operation_id),
    job_id TEXT NOT NULL, request_hash TEXT NOT NULL, scope_key TEXT NOT NULL REFERENCES local_posts_custody(scope_key),
    signed_hash TEXT
  )`,
  `CREATE TRIGGER local_posts_job_lease_gate BEFORE UPDATE OF lease_token ON publication_jobs
    WHEN NEW.lease_token IS NOT NULL AND NEW.lease_token IS NOT OLD.lease_token
      AND NOT EXISTS(SELECT 1 FROM local_posts_custody WHERE slot=1 AND state='posts')
    BEGIN SELECT RAISE(IGNORE); END`,
] as const;

const open =
  "EXISTS(SELECT 1 FROM local_posts_custody WHERE slot=1 AND scope_key=? AND state='posts')";
const drainingOwner =
  "EXISTS(SELECT 1 FROM local_posts_custody WHERE slot=1 AND scope_key=? AND state IN ('posts','draining'))";
const liveOriginal = `EXISTS(SELECT 1 FROM external_operations o JOIN publication_jobs j ON j.job_id=o.job_id
  WHERE o.operation_id=? AND o.job_id=? AND o.step='publication' AND o.request_hash=?
    AND j.lease_token=? AND j.lease_until>${POSTS_DB_CLOCK} AND j.phase='publication'`;
const noEarlierEffect = `NOT EXISTS(SELECT 1 FROM local_posts_effects f
  LEFT JOIN external_operations o ON o.operation_id=f.operation_id
  WHERE f.scope_key=? AND f.operation_id<>? AND COALESCE(o.status,'')<>'confirmed')`;

export class LocalPostsEffectFence {
  readonly scope: LocalPostsScope;
  readonly key: Hex;
  readonly db: D1Database;

  constructor(db: D1Database, scope: LocalPostsScope) {
    this.db = db;
    this.scope = Object.freeze({
      ...scope,
      ...(scope.native ? { native: Object.freeze({ ...scope.native }) } : {}),
    });
    this.key = hashJson(this.scope);
  }

  assertScope(db: D1Database, config: CommunityConfig, publisher: string) {
    const s = this.scope;
    insist(
      db === this.db &&
        config.schema === "pirate.community-config/4" &&
        config.chainId === s.chainId &&
        config.installationId === s.installationId &&
        config.communityId === s.communityId &&
        config.app.origin === s.origin &&
        config.publisher === s.publisher &&
        publisher.toLowerCase() === s.publisher,
      "local_posts_custody_scope_changed",
      409,
    );
  }

  assertApplicationRpc(url: string) {
    insist(
      /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(this.scope.rpcUrl) &&
        url === (this.scope.native?.applicationRpcUrl ?? this.scope.rpcUrl),
      "local_posts_custody_scope_changed",
      409,
    );
  }

  async assertNode(client: PublicClient) {
    const s = this.scope;
    insist(
      /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(s.rpcUrl) &&
        (client.transport.url === s.rpcUrl ||
          (s.native && client.transport.url === s.native.applicationRpcUrl)),
      "local_posts_custody_chain_changed",
      409,
    );
    const [chainId, genesis] = await Promise.all([
      client.getChainId(),
      client.getBlock({ blockNumber: 0n }),
    ]);
    insist(
      chainId === s.chainId && genesis.hash === s.genesisHash,
      "local_posts_custody_chain_changed",
      409,
    );
  }

  private identity(operation: ExternalOperation, job?: PublicationJob) {
    insist(
      job?.lease_token &&
        job.job_id === operation.job_id &&
        operation.step === "publication",
      "local_posts_custody_job_required",
      409,
    );
    return [
      operation.operation_id,
      operation.job_id,
      operation.request_hash,
      job.lease_token,
    ] as const;
  }

  async beforeSign(operation: ExternalOperation, job?: PublicationJob) {
    const identity = this.identity(operation, job);
    // Keep the marker until the original is durable in external_operations.
    // A lost process cannot use an expired job lease to erase this boundary.
    const saved = await this.db
      .prepare(
        `INSERT INTO local_posts_effects(operation_id,job_id,request_hash,scope_key,signed_hash)
       SELECT ?,?,?,?,NULL WHERE (${open}) AND ${liveOriginal} AND o.status='planned' AND o.prepared_json IS NULL)
       AND (${noEarlierEffect}) ON CONFLICT(operation_id) DO NOTHING`,
      )
      .bind(
        operation.operation_id,
        operation.job_id,
        operation.request_hash,
        this.key,
        this.key,
        ...identity,
        this.key,
        operation.operation_id,
      )
      .run();
    insist(saved.meta.changes === 1, "local_posts_signing_fenced", 409);
  }

  async beforeSend(
    operation: ExternalOperation,
    signedHash: Hex,
    job?: PublicationJob,
  ) {
    const identity = this.identity(operation, job);
    const saved = await this.db
      .prepare(
        `UPDATE local_posts_effects SET signed_hash=?
       WHERE scope_key=? AND operation_id=? AND job_id=? AND request_hash=?
         AND (signed_hash IS NULL OR signed_hash=?) AND (${drainingOwner})
         AND ${liveOriginal} AND o.status='running' AND o.prepared_json=?
           AND json_extract(o.prepared_json,'$.replay.transactionHash')=?)
         AND (${noEarlierEffect})`,
      )
      .bind(
        signedHash,
        this.key,
        operation.operation_id,
        operation.job_id,
        operation.request_hash,
        signedHash,
        this.key,
        ...identity,
        operation.prepared_json,
        signedHash,
        this.key,
        operation.operation_id,
      )
      .run();
    insist(saved.meta.changes === 1, "local_posts_sending_fenced", 409);
  }

  scopeJson() {
    return canonical(this.scope);
  }
}
