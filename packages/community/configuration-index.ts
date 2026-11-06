// Durable evidence cache using the existing public configuration/index tables.
// Cached bytes never replace current contract, receipt or canonical-block checks.
import {
  BlockNotFoundError,
  decodeEventLog,
  type Hex,
  type PublicClient,
} from "viem";
import { canonical, hashText, insist, token } from "./common.ts";
import {
  directoryAbi,
  type DirectoryHistoryCache,
  type DirectoryProfile,
  type DirectoryCheckpoint,
  type ConfigurationLog,
} from "./directory-reader.ts";

interface Cursor {
  next_block: string;
  checkpoint_hash: Hex;
}
interface Entry {
  revision: number;
  publisher: string;
  manifest_uri: string;
  manifest_sha256: Hex;
  manifest_json: string;
  block_number: string;
  block_hash: Hex;
  transaction_hash: Hex;
}
async function boundedMap<T, R>(items: T[], fn: (item: T) => Promise<R>) {
  const result: R[] = [];
  for (let i = 0; i < items.length; i += 4)
    result.push(...(await Promise.all(items.slice(i, i + 4).map(fn))));
  return result;
}
const raced = (error: unknown) =>
  error instanceof Error &&
  error.message.includes("CHECK constraint failed: valid = 1");

export function directoryHistoryCache(
  db: D1Database,
  client: PublicClient,
  profile: DirectoryProfile,
): DirectoryHistoryCache {
  const key = `directory/1:${hashText(canonical({ ...profile, deploymentBlock: String(profile.deploymentBlock) }))}`;
  const identity = [profile.chainId, key];
  const cursor = () =>
    db
      .prepare(
        "SELECT next_block,checkpoint_hash FROM chain_scan_state WHERE chain_id=? AND contract_address=?",
      )
      .bind(...identity)
      .first<Cursor>();
  const guard = (previous: DirectoryCheckpoint | undefined) => {
    const id = token();
    const condition = previous
      ? "EXISTS(SELECT 1 FROM chain_scan_state WHERE chain_id=? AND contract_address=? AND next_block=? AND checkpoint_hash=?)"
      : "NOT EXISTS(SELECT 1 FROM chain_scan_state WHERE chain_id=? AND contract_address=?)";
    return {
      id,
      statement: db
        .prepare(
          `INSERT INTO transaction_guards(guard_id,valid) VALUES(?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
        )
        .bind(
          id,
          ...identity,
          ...(previous ? [String(previous.nextBlock), previous.blockHash] : []),
        ),
    };
  };
  return {
    async load() {
      const saved = await cursor();
      if (!saved) return undefined;
      const nextBlock = BigInt(saved.next_block);
      insist(
        nextBlock > profile.deploymentBlock,
        "directory_cache_cursor_invalid",
        503,
      );
      let canonicalHash: Hex | null = null;
      try {
        canonicalHash = (await client.getBlock({ blockNumber: nextBlock - 1n }))
          .hash;
      } catch (error) {
        if (!(error instanceof BlockNotFoundError)) throw error;
      }
      if (canonicalHash !== saved.checkpoint_hash) {
        // Public derived cache only. Rebuild from canonical evidence after a reorg.
        const check = guard({
          nextBlock,
          blockHash: saved.checkpoint_hash,
          logs: [],
          documents: new Map(),
        });
        await db.batch([
          check.statement,
          db
            .prepare("DELETE FROM public_configurations WHERE community_id=?")
            .bind(profile.communityId),
          db
            .prepare(
              "DELETE FROM chain_scan_state WHERE chain_id=? AND contract_address=?",
            )
            .bind(...identity),
          db
            .prepare("DELETE FROM transaction_guards WHERE guard_id=?")
            .bind(check.id),
        ]);
        return undefined;
      }
      const rows = (
        await db
          .prepare(
            "SELECT * FROM public_configurations WHERE community_id=? ORDER BY revision",
          )
          .bind(profile.communityId)
          .all<Entry>()
      ).results;
      insist(
        rows.length > 0 && rows.length <= 256,
        "directory_cache_history_invalid",
        503,
      );
      const logs = await boundedMap(rows, async (row) => {
        const [receipt, block] = await Promise.all([
          client.getTransactionReceipt({ hash: row.transaction_hash }),
          client.getBlock({ blockNumber: BigInt(row.block_number) }),
        ]);
        insist(
          receipt.status === "success" &&
            receipt.transactionHash === row.transaction_hash &&
            receipt.blockHash === row.block_hash &&
            block.hash === row.block_hash &&
            receipt.blockNumber === BigInt(row.block_number),
          "directory_cache_provenance_changed",
          503,
        );
        const matching: ConfigurationLog[] = [];
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== profile.directory.toLowerCase())
            continue;
          let args;
          try {
            args = decodeEventLog({
              abi: directoryAbi,
              eventName: "ConfigurationPublished",
              data: log.data,
              topics: log.topics,
              strict: true,
            }).args;
          } catch {
            continue;
          }
          if (
            args.communityId !== profile.communityId ||
            args.revision !== BigInt(row.revision)
          )
            continue;
          insist(
            args.publisher.toLowerCase() === row.publisher &&
              args.uri === row.manifest_uri &&
              args.sha256Digest === row.manifest_sha256 &&
              log.blockHash === row.block_hash &&
              log.blockNumber === receipt.blockNumber &&
              log.transactionHash === receipt.transactionHash &&
              log.logIndex !== null,
            "directory_cache_event_changed",
            503,
          );
          matching.push({
            args,
            blockNumber: receipt.blockNumber,
            blockHash: row.block_hash,
            transactionHash: receipt.transactionHash,
            logIndex: log.logIndex,
          });
        }
        insist(matching.length === 1, "directory_cache_event_missing", 503);
        return matching[0]!;
      });
      return {
        nextBlock,
        blockHash: saved.checkpoint_hash,
        logs,
        documents: new Map(
          rows.map((row) => [row.manifest_uri, row.manifest_json]),
        ),
      };
    },
    async save(previous, head, hash, logs, history) {
      const check = guard(previous);
      try {
        await db.batch([
          check.statement,
          db
            .prepare("DELETE FROM public_configurations WHERE community_id=?")
            .bind(profile.communityId),
          ...logs.map((log, i) =>
            db
              .prepare(
                `INSERT INTO public_configurations(community_id,revision,publisher,manifest_uri,manifest_sha256,manifest_json,block_number,block_hash,transaction_hash) VALUES(?,?,?,?,?,?,?,?,?)`,
              )
              .bind(
                profile.communityId,
                Number(log.args.revision),
                log.args.publisher.toLowerCase(),
                log.args.uri,
                log.args.sha256Digest,
                canonical(history[i]!),
                String(log.blockNumber),
                log.blockHash,
                log.transactionHash,
              ),
          ),
          db
            .prepare(
              "INSERT INTO chain_scan_state(chain_id,contract_address,next_block,checkpoint_hash) VALUES(?,?,?,?) ON CONFLICT(chain_id,contract_address) DO UPDATE SET next_block=excluded.next_block,checkpoint_hash=excluded.checkpoint_hash",
            )
            .bind(...identity, String(head + 1n), hash),
          db
            .prepare("DELETE FROM transaction_guards WHERE guard_id=?")
            .bind(check.id),
        ]);
      } catch (error) {
        // A concurrent winner is retained. The caller's independently verified
        // snapshot is still valid; never move the durable cursor backwards.
        if (!raced(error)) throw error;
      }
    },
  };
}
