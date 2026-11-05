import { decodeEventLog, type Hex, type PublicClient } from "viem";
import { canonical, insist, token } from "./common.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import { fetchPublicIpfs, type IpfsTransport } from "./ipfs.ts";
import {
  postsAbi,
  publicationEvent,
  verifiedPostsHead,
  type PostsProfile,
} from "./post-chain.ts";
import {
  quarantined,
  validatePostForEvent,
  type PublicationEvent,
} from "./post-manifest.ts";

interface Cursor {
  next_block: string;
  checkpoint_hash: string | null;
}
export interface IndexedPost {
  community_id: Hex;
  post_id: Hex;
  revision: number;
  author_id: Hex;
  configuration_revision: number;
  manifest_uri: string;
  manifest_sha256: Hex;
  manifest_json: string;
  block_number: string;
  block_hash: Hex;
  transaction_hash: Hex;
  log_index: number;
  quarantined: number;
}
const scanKey = (profile: PostsProfile) => [6343, profile.address];
const loadCursor = (db: D1Database, profile: PostsProfile) =>
  db
    .prepare(
      "SELECT next_block,checkpoint_hash FROM chain_scan_state WHERE chain_id=? AND contract_address=?",
    )
    .bind(...scanKey(profile))
    .first<Cursor>();
const eventFor = (
  row: IndexedPost,
  profile: PostsProfile,
): PublicationEvent => ({
  chainId: 6343,
  postsContract: profile.address,
  communityId: row.community_id,
  postId: row.post_id,
  authorId: row.author_id,
  kind: 0,
  revision: row.revision,
  configurationRevision: row.configuration_revision,
  manifestURI: row.manifest_uri,
  manifestSha256: row.manifest_sha256,
});

/** Bounded, restartable public index. A cursor moves atomically with validated
 * content. A changed canonical checkpoint fails closed for explicit recovery. */
export async function syncPublicPosts(
  db: D1Database,
  client: PublicClient,
  profile: PostsProfile,
  history: CommunityConfig[],
  current: CommunityConfig,
  transport?: IpfsTransport,
) {
  const head = await verifiedPostsHead(client, profile, current);
  let cursor = await loadCursor(db, profile),
    from = cursor ? BigInt(cursor.next_block) : profile.deploymentBlock;
  if (cursor?.checkpoint_hash) {
    const checkpoint = await client.getBlock({ blockNumber: from - 1n });
    insist(
      checkpoint.hash === cursor.checkpoint_hash,
      "public_index_checkpoint_changed",
      503,
    );
  }
  for (let page = 0; page < 8 && from <= head; page++) {
    const to = from + 9999n < head ? from + 9999n : head;
    const logs = await client.getLogs({
      address: profile.address,
      event: postsAbi[3],
      args: { communityId: current.communityId },
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    insist(logs.length <= 100, "public_index_page_too_large", 503);
    const writes: D1PreparedStatement[] = [];
    for (const log of logs) {
      if (log.args.kind !== 0) continue;
      const publication = publicationEvent(log.args, profile),
        config = history.find(
          (c) => c.configurationRevision === publication.configurationRevision,
        );
      insist(config, "publication_configuration_missing", 503);
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      insist(block.hash === log.blockHash, "public_post_block_changed", 503);
      const revoked = quarantined(
        publication,
        log.blockNumber,
        history,
        current,
      );
      let manifest = "null";
      if (!revoked) {
        const { bytes } = await fetchPublicIpfs(
          publication.manifestURI,
          publication.manifestSha256,
          1024 * 1024,
          transport,
        );
        manifest = canonical(
          validatePostForEvent(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
            publication,
            config,
          ),
        );
      }
      writes.push(
        db
          .prepare(
            `INSERT INTO public_post_revisions(community_id,post_id,revision,author_id,configuration_revision,manifest_uri,manifest_sha256,manifest_json,block_number,block_hash,transaction_hash,log_index,quarantined)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(community_id,post_id,revision) DO UPDATE SET author_id=excluded.author_id,configuration_revision=excluded.configuration_revision,manifest_uri=excluded.manifest_uri,manifest_sha256=excluded.manifest_sha256,manifest_json=excluded.manifest_json,block_number=excluded.block_number,block_hash=excluded.block_hash,transaction_hash=excluded.transaction_hash,log_index=excluded.log_index,quarantined=excluded.quarantined`,
          )
          .bind(
            publication.communityId,
            publication.postId,
            publication.revision,
            publication.authorId,
            publication.configurationRevision,
            publication.manifestURI,
            publication.manifestSha256,
            manifest,
            log.blockNumber.toString(),
            log.blockHash,
            log.transactionHash,
            log.logIndex,
            revoked ? 1 : 0,
          ),
      );
    }
    const checkpoint = await client.getBlock({ blockNumber: to }),
      guard = token();
    insist(checkpoint.hash, "public_index_block_unavailable", 503);
    const condition = cursor
      ? "EXISTS(SELECT 1 FROM chain_scan_state WHERE chain_id=? AND contract_address=? AND next_block=? AND checkpoint_hash IS ?)"
      : "NOT EXISTS(SELECT 1 FROM chain_scan_state WHERE chain_id=? AND contract_address=?)";
    const args = cursor
      ? [...scanKey(profile), cursor.next_block, cursor.checkpoint_hash]
      : scanKey(profile);
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO transaction_guards(guard_id,valid) VALUES(?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
          )
          .bind(guard, ...args),
        ...writes,
        db
          .prepare(
            "INSERT INTO chain_scan_state(chain_id,contract_address,next_block,checkpoint_hash) VALUES(?,?,?,?) ON CONFLICT(chain_id,contract_address) DO UPDATE SET next_block=excluded.next_block,checkpoint_hash=excluded.checkpoint_hash",
          )
          .bind(...scanKey(profile), (to + 1n).toString(), checkpoint.hash),
        db
          .prepare("DELETE FROM transaction_guards WHERE guard_id=?")
          .bind(guard),
      ]);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          error.message.includes("CHECK constraint failed: valid = 1")
        )
      )
        throw error;
      const advanced = await loadCursor(db, profile);
      insist(
        advanced &&
          BigInt(advanced.next_block) > from &&
          advanced.checkpoint_hash,
        "public_index_progress_changed",
        503,
      );
      const canonicalCheckpoint = await client.getBlock({
        blockNumber: BigInt(advanced.next_block) - 1n,
      });
      insist(
        canonicalCheckpoint.hash === advanced.checkpoint_hash,
        "public_index_checkpoint_changed",
        503,
      );
      cursor = advanced;
      from = BigInt(advanced.next_block);
      continue;
    }
    cursor = {
      next_block: (to + 1n).toString(),
      checkpoint_hash: checkpoint.hash,
    };
    from = to + 1n;
  }
  const saved = await loadCursor(db, profile);
  return { caughtUp: !!saved && BigInt(saved.next_block) > head, head };
}
/** Cached bytes remain tied to the current confirmed contract state and their
 * canonical block. Private accounts and processing jobs are not feed sources. */
export async function indexedPublicPosts(
  db: D1Database,
  client: PublicClient,
  profile: PostsProfile,
  history: CommunityConfig[],
  current: CommunityConfig,
  head: bigint,
  postId?: string,
) {
  const query = `SELECT r.* FROM public_post_revisions r WHERE r.community_id=? AND CAST(r.block_number AS INTEGER)<=CAST(? AS INTEGER) ${postId ? "AND r.post_id=?" : ""} AND r.revision=(SELECT MAX(p.revision) FROM public_post_revisions p WHERE p.community_id=r.community_id AND p.post_id=r.post_id AND CAST(p.block_number AS INTEGER)<=CAST(? AS INTEGER)) ORDER BY CAST(r.block_number AS INTEGER) DESC,r.log_index DESC LIMIT 100`;
  const rows = await db
      .prepare(query)
      .bind(
        current.communityId,
        head.toString(),
        ...(postId ? [postId] : []),
        head.toString(),
      )
      .all<IndexedPost>(),
    result = [];
  for (const row of rows.results) {
    const event = eventFor(row, profile);
    if (quarantined(event, BigInt(row.block_number), history, current))
      continue;
    const [onchain, block] = await Promise.all([
      client.readContract({
        address: profile.address,
        abi: postsAbi,
        functionName: "getPost",
        args: [current.communityId, row.post_id],
        blockNumber: head,
      }),
      client.getBlock({ blockNumber: BigInt(row.block_number) }),
    ]);
    insist(
      block.hash === row.block_hash &&
        onchain.authorId === row.author_id &&
        onchain.kind === 0 &&
        onchain.revision === BigInt(row.revision) &&
        onchain.configurationRevision === BigInt(row.configuration_revision) &&
        onchain.manifestSha256 === row.manifest_sha256 &&
        onchain.manifestURI === row.manifest_uri,
      "public_post_state_changed",
      503,
    );
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({
        hash: row.transaction_hash,
      });
    } catch {
      insist(false, "public_post_provenance_unavailable", 503);
    }
    const log = receipt.logs.find(
      (log) =>
        log.logIndex === row.log_index &&
        log.address.toLowerCase() === profile.address,
    );
    insist(
      receipt.status === "success" &&
        receipt.transactionHash === row.transaction_hash &&
        receipt.blockHash === row.block_hash &&
        receipt.blockNumber === BigInt(row.block_number) &&
        log &&
        log.transactionHash === row.transaction_hash &&
        log.blockHash === row.block_hash &&
        log.blockNumber === BigInt(row.block_number),
      "public_post_provenance_changed",
      503,
    );
    const decoded = publicationEvent(
      decodeEventLog({
        abi: postsAbi,
        eventName: "PostRevisionPublished",
        topics: log.topics,
        data: log.data,
        strict: true,
      }).args,
      profile,
    );
    insist(
      canonical(decoded) === canonical(event),
      "public_post_provenance_changed",
      503,
    );
    const config = history.find(
      (c) => c.configurationRevision === row.configuration_revision,
    );
    insist(config, "publication_configuration_missing", 503);
    result.push({
      post: validatePostForEvent(JSON.parse(row.manifest_json), event, config),
      transactionHash: row.transaction_hash,
      blockNumber: row.block_number,
    });
  }
  return result;
}
