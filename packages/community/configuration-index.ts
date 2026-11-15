// Proposed paged cache schema; Root must admit the accompanying exact DDL before
// mounting this adapter. No automatic migration, schema creation or V1-row deletion.
import { BlockNotFoundError, type Hex, type PublicClient } from "viem";
import { canonical, exact, hashText, insist, integer, object, token } from "./common.ts";
import { address, decimal } from "./manifest-core.ts";
import { sharedBytes32 } from "./shared-identity.ts";
import { CONFIGURATION_PAGE_SIZE, encodeEvidence, type ConfigurationEvidence,
  type DirectoryCheckpoint, type DirectoryHistoryCache } from "./directory-checkpoint.ts";
import type { AnyDirectoryProfile } from "./directory-reader.ts";

interface Head { snapshot: string; next_block: string; block_hash: Hex; revision: number; page_count: number }
interface Page { page_number: number; page_sha256: string; payload: string }
const raced = (e: unknown) => e instanceof Error && e.message.includes("CHECK constraint failed: valid = 1");
// Snapshot alone is not a version: unchanged revisions now reuse their pages.
const priorHead = "profile_key=? AND snapshot=? AND next_block=? AND block_hash=? AND revision=? AND page_count=?";
const priorValues = (key: string, saved: DirectoryCheckpoint) =>
  [key, saved.snapshot, String(saved.nextBlock), saved.blockHash, saved.revision, saved.pages];
export function decodeEvidence(payload: string): ConfigurationEvidence[] {
  const raw: unknown = JSON.parse(payload);
  insist(Array.isArray(raw) && raw.length > 0 && raw.length <= CONFIGURATION_PAGE_SIZE, "invalid_checkpoint_page");
  const result = raw.map((value) => {
    const o = object(value), a = object(o.args);
    exact(o, ["args", "blockNumber", "blockHash", "transactionHash", "logIndex", "document"]);
    exact(a, ["communityId", "revision", "controller", "publisher", "operatorPayments", "learningRecords", "sha256Digest", "uri"]);
    insist(typeof o.document === "string" && new TextEncoder().encode(o.document).length <= 65536 &&
      typeof a.uri === "string", "invalid_checkpoint_document");
    return { document: o.document, log: {
      args: { communityId: sharedBytes32(a.communityId), revision: BigInt(decimal(a.revision)),
        controller: address(a.controller), publisher: address(a.publisher), operatorPayments: address(a.operatorPayments, true),
        learningRecords: address(a.learningRecords, true), sha256Digest: sharedBytes32(a.sha256Digest), uri: a.uri },
      blockNumber: BigInt(decimal(o.blockNumber)), blockHash: sharedBytes32(o.blockHash),
      transactionHash: sharedBytes32(o.transactionHash), logIndex: integer(o.logIndex, 0, Number.MAX_SAFE_INTEGER),
    } };
  });
  insist(encodeEvidence(result) === payload, "noncanonical_checkpoint_page");
  return result;
}
export function directoryHistoryCache(db: D1Database, client: PublicClient, profile: AnyDirectoryProfile): DirectoryHistoryCache {
  const key = "directory/2:" + hashText(canonical({ ...profile, deploymentBlock: String(profile.deploymentBlock) }));
  return {
    async load(through) {
      const row = await db.prepare("SELECT * FROM directory_checkpoint_heads WHERE profile_key=?").bind(key).first<Head>();
      if (!row) return undefined;
      insist(/^[0-9a-f]{64}(?![\s\S])/.test(row.snapshot), "invalid_checkpoint_snapshot");
      const nextBlock = BigInt(decimal(row.next_block));
      insist(nextBlock > profile.deploymentBlock, "directory_cache_cursor_invalid", 503);
      const revision = integer(row.revision, 1, Number.MAX_SAFE_INTEGER), pages = integer(row.page_count, 1, Number.MAX_SAFE_INTEGER);
      insist(pages === Math.ceil(revision / CONFIGURATION_PAGE_SIZE), "directory_cache_history_invalid", 503);
      const saved = Object.freeze({ snapshot: row.snapshot, nextBlock, blockHash: sharedBytes32(row.block_hash), revision, pages });
      let block;
      try { block = await client.getBlock({ blockNumber: nextBlock - 1n }); }
      catch (error) {
        if (!(error instanceof BlockNotFoundError)) throw error;
        insist(false, "directory_cache_view_unavailable", 503);
      }
      insist(block.number === nextBlock - 1n && block.hash !== null, "directory_cache_view_unavailable", 503);
      const canonicalHash = sharedBytes32(block.hash);
      if (canonicalHash !== saved.blockHash) {
        // A proven canonical mismatch may evict only the exact observed head.
        // Retain immutable evidence and never erase a concurrently advanced head.
        const removed = await db.prepare(`DELETE FROM directory_checkpoint_heads WHERE ${priorHead}`)
          .bind(...priorValues(key, saved)).run();
        insist(removed.meta.changes === 1, "directory_cache_cursor_raced", 503);
        return undefined;
      }
      insist(nextBlock <= through + 1n, "directory_cache_view_unavailable", 503);
      return saved;
    },
    async *pages(saved) {
      let count = 0;
      for (let page = 0; page < saved.pages; page++) {
        const row = await db.prepare("SELECT page_number,page_sha256,payload FROM directory_checkpoint_pages WHERE snapshot=? AND page_number=?")
          .bind(saved.snapshot, page).first<Page>();
        insist(row && row.page_number === page && hashText(row.payload) === row.page_sha256, "directory_cache_page_changed", 503);
        const entries = decodeEvidence(row.payload);
        insist(page === saved.pages - 1 || entries.length === CONFIGURATION_PAGE_SIZE, "directory_cache_page_gap", 503);
        for (const item of entries) insist(item.log.args.revision === BigInt(++count), "directory_cache_page_gap", 503);
        yield entries;
      }
      insist(count === saved.revision, "directory_cache_history_invalid", 503);
    },
    async advance(previous, head, hash) {
      // Capture complete scalar bindings before awaiting the engine. No page IO.
      const expected = priorValues(key, previous);
      insist(head + 1n >= previous.nextBlock, "invalid_checkpoint_commit");
      const result = await db.prepare(`UPDATE directory_checkpoint_heads SET next_block=?,block_hash=? WHERE ${priorHead}`)
        .bind(String(head + 1n), sharedBytes32(hash), ...expected).run();
      return result.meta.changes === 1;
    },
    begin(previous) {
      const expected = previous && priorValues(key, previous), previousNextBlock = previous?.nextBlock;
      const snapshot = token();
      let pages = 0, revisions = 0, ended = false, partial = false;
      return {
        async append(page) {
          insist(!ended && !partial, "checkpoint_writer_closed");
          const payload = encodeEvidence(page);
          for (const item of page) insist(item.log.args.revision === BigInt(++revisions), "directory_cache_page_gap");
          // Each bounded page is durable before the head can reference it.
          await db.prepare("INSERT INTO directory_checkpoint_pages(snapshot,page_number,page_sha256,payload) VALUES(?,?,?,?)")
            .bind(snapshot, pages++, hashText(payload), payload).run();
          partial = page.length < CONFIGURATION_PAGE_SIZE;
        },
        async commit(head, hash, revision) {
          insist(!ended && pages > 0 && revisions === revision && (previousNextBlock === undefined || head + 1n >= previousNextBlock), "invalid_checkpoint_commit");
          ended = true;
          const guard = token(), condition = expected
            ? `EXISTS(SELECT 1 FROM directory_checkpoint_heads WHERE ${priorHead})`
            : "NOT EXISTS(SELECT 1 FROM directory_checkpoint_heads WHERE profile_key=?)";
          try {
            await db.batch([
              db.prepare(`INSERT INTO transaction_guards(guard_id,valid) VALUES(?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`)
                .bind(guard, ...(expected ?? [key])),
              db.prepare("INSERT INTO directory_checkpoint_heads(profile_key,snapshot,next_block,block_hash,revision,page_count) VALUES(?,?,?,?,?,?) ON CONFLICT(profile_key) DO UPDATE SET snapshot=excluded.snapshot,next_block=excluded.next_block,block_hash=excluded.block_hash,revision=excluded.revision,page_count=excluded.page_count")
                .bind(key, snapshot, String(head + 1n), hash, revision, pages),
              db.prepare("DELETE FROM transaction_guards WHERE guard_id=?").bind(guard),
            ]);
            return true;
          } catch (error) { if (!raced(error)) throw error; return false; }
        },
      };
    },
  };
}
