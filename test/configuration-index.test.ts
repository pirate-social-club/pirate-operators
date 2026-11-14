import { prepareDirectoryCache } from "./fixtures/directory-checkpoint-schema.ts";
import { hashText } from "../packages/community/common.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { communityRuntime } from "./community-runtime.ts";
import { directoryFixture } from "./fixtures/directory-reader.ts";
import { readConfigurationHistory } from "../packages/community/directory-reader.ts";
import { directoryHistoryCache } from "../packages/community/configuration-index.ts";
import { BlockNotFoundError, type Hex } from "viem";
import type { DirectoryCheckpoint } from "../packages/community/directory-checkpoint.ts";

const hash = (s: string) => `0x${s.repeat(64)}` as const;
test("directory checkpoints survive new request objects; unchanged revisions scan no history even days later", async () => {
  const runtime = await communityRuntime();
  await prepareDirectoryCache(runtime.db);
  const f = await directoryFixture();
  const read = () =>
    readConfigurationHistory(
      f.client,
      f.profile,
      f.transport,
      directoryHistoryCache(runtime.db, f.client, f.profile),
    );
  try {
    assert.deepEqual(await read(), [f.config]);
    assert.equal(f.state.logRanges.length, 1);
    assert.equal(f.state.downloads, 1);
    f.state.head += 86400n;
    assert.deepEqual(await read(), [f.config]);
    assert.equal(f.state.logRanges.length, 1);
    assert.equal(f.state.downloads, 1);
    const through = f.state.head;
    f.state.head += 2n;
    const newer = await f.extend();
    assert.deepEqual(await read(), [f.config, newer]);
    assert.deepEqual(f.state.logRanges.at(-1), [through, f.state.head - 1n]);
    assert.equal(f.state.downloads, 2);
    assert.deepEqual(await read(), [f.config, newer]);
    assert.equal(f.state.logRanges.length, 2);
    assert.equal(f.state.downloads, 2);
  } finally {
    await runtime.dispose();
  }
});
test("a changed canonical checkpoint discards only the derived cache and reconstructs the new chain", async () => {
  const runtime = await communityRuntime();
  await prepareDirectoryCache(runtime.db);
  const f = await directoryFixture();
  const read = () =>
    readConfigurationHistory(
      f.client,
      f.profile,
      f.transport,
      directoryHistoryCache(runtime.db, f.client, f.profile),
    );
  try {
    await read();
    f.state.hash = hash("b");
    assert.deepEqual(await read(), [f.config]);
    assert.equal(f.state.logRanges.length, 2);
    assert.equal(f.state.downloads, 2);
    assert.deepEqual(await read(), [f.config]);
    assert.equal(f.state.downloads, 2);
  } finally {
    await runtime.dispose();
  }
});
test("cached content remains digest-bound and does not replace publication receipt authentication", async () => {
  const runtime = await communityRuntime();
  await prepareDirectoryCache(runtime.db);
  const f = await directoryFixture();
  const read = () =>
    readConfigurationHistory(
      f.client,
      f.profile,
      f.transport,
      directoryHistoryCache(runtime.db, f.client, f.profile),
    );
  try {
    await read();
    const row = await runtime.db.prepare("SELECT snapshot,page_number,payload FROM directory_checkpoint_pages LIMIT 1")
      .first<{ snapshot: string; page_number: number; payload: string }>();
    assert.ok(row);
    const payload = JSON.parse(row.payload);
    payload[0].args.publisher = "0x" + "9".repeat(40);
    // A forged self-hash is insufficient: canonical receipt authentication remains.
    const { canonical } = await import("../packages/community/common.ts");
    const forged = canonical(payload);
    await runtime.db.prepare("UPDATE directory_checkpoint_pages SET payload=?,page_sha256=? WHERE snapshot=? AND page_number=?")
      .bind(forged, hashText(forged), row.snapshot, row.page_number).run();
    await assert.rejects(read(), /directory_cache_event_changed/);
    payload[0].args.publisher = f.config.publisher;
    payload[0].document = '{"fabricated":true}';
    const bytes = canonical(payload);
    await runtime.db.prepare("UPDATE directory_checkpoint_pages SET payload=?,page_sha256=? WHERE snapshot=? AND page_number=?")
      .bind(bytes, hashText(bytes), row.snapshot, row.page_number).run();
    await assert.rejects(read());
  } finally {
    await runtime.dispose();
  }
});
test("concurrent cold readers cannot replace the winner's newer checkpoint with an older snapshot", async () => {
  const runtime = await communityRuntime();
  await prepareDirectoryCache(runtime.db);
  const f = await directoryFixture();
  let releaseOld!: () => void, arrived!: () => void;
  const waitOld = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldAtLogs = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const older = new Proxy(f.client, {
    get(target, property) {
      if (property === "getBlockNumber") return async () => 100n;
      if (property === "getLogs")
        return async (parameters: Parameters<typeof target.getLogs>[0]) => {
          arrived();
          await waitOld;
          return target.getLogs(parameters);
        };
      return Reflect.get(target, property);
    },
  });
  try {
    const old = readConfigurationHistory(
      older,
      f.profile,
      f.transport,
      directoryHistoryCache(runtime.db, older, f.profile),
    );
    await oldAtLogs;
    f.state.head = 200n;
    const newer = await f.extend();
    assert.deepEqual(
      await readConfigurationHistory(
        f.client,
        f.profile,
        f.transport,
        directoryHistoryCache(runtime.db, f.client, f.profile),
      ),
      [f.config, newer],
    );
    releaseOld();
    assert.deepEqual(await old, [f.config]);
    const cursor = await runtime.db
      .prepare("SELECT next_block FROM directory_checkpoint_heads")
      .first<{ next_block: string }>();
    assert.equal(cursor?.next_block, "200");
    assert.equal(
      (
        await runtime.db
          .prepare("SELECT revision AS n FROM directory_checkpoint_heads")
          .first()
      )?.n,
      2,
    );
    assert.equal(
      (
        await runtime.db
          .prepare("SELECT COUNT(*) AS n FROM transaction_guards")
          .first()
      )?.n,
      0,
    );
  } finally {
    releaseOld();
    await runtime.dispose();
  }
});

test("a checkpoint above a regressed chain head is rebuilt without serving future history", async () => {
  const runtime = await communityRuntime();
  await prepareDirectoryCache(runtime.db);
  const f = await directoryFixture();
  const read = () =>
    readConfigurationHistory(
      f.client,
      f.profile,
      f.transport,
      directoryHistoryCache(runtime.db, f.client, f.profile),
    );
  try {
    await read();
    const prior = await f.client.getBlock({ blockNumber: 99n });
    f.state.head = 90n;
    // Regression alone is uncertainty, not evidence of a reorg. Preserve the
    // old checkpoint until a separately observed canonical mismatch proves it.
    await assert.rejects(read(), /directory_cache_view_unavailable/);
    assert.equal((await runtime.db.prepare("SELECT next_block FROM directory_checkpoint_heads").first())?.next_block, "100");
    f.state.hash = hash("b");
    const proof = new Proxy(f.client, { get(target, key) {
      if (key === "getBlock") return async (input: Parameters<typeof target.getBlock>[0]) =>
        input?.blockNumber === 99n ? { ...prior, hash: f.state.hash } : target.getBlock(input);
      return Reflect.get(target, key);
    } });
    // Explicit simulated load-balanced RPC: this node can prove block99's
    // changed hash while the selected read node still reports height90.
    assert.equal(await directoryHistoryCache(runtime.db, proof, f.profile).load(89n), undefined);
    assert.deepEqual(await read(), [f.config]);
    assert.equal(f.state.logRanges.length, 2);
    assert.equal(
      (
        await runtime.db
          .prepare("SELECT next_block FROM directory_checkpoint_heads")
          .first()
      )?.next_block,
      "90",
    );
  } finally {
    await runtime.dispose();
  }
});

test("stable revisions advance the authenticated head without rewriting any cache page", async () => {
  const runtime = await communityRuntime();
  try {
    await prepareDirectoryCache(runtime.db);
    const f = await directoryFixture();
    for (let i = 1; i < 17; i++) { f.state.head += 2n; await f.extend(); }
    const read = () => readConfigurationHistory(f.client, f.profile, f.transport,
      directoryHistoryCache(runtime.db, f.client, f.profile));
    await read();
    const rows = () => runtime.db.prepare("SELECT snapshot,page_number,page_sha256,payload FROM directory_checkpoint_pages ORDER BY snapshot,page_number").all();
    const before = (await rows()).results;
    const head = await runtime.db.prepare("SELECT snapshot,revision,page_count FROM directory_checkpoint_heads").first();
    for (let i = 0; i < 4; i++) {
      f.state.head += 100n;
      assert.equal((await read()).length, 17);
      assert.deepEqual((await rows()).results, before);
      assert.deepEqual(await runtime.db.prepare("SELECT snapshot,revision,page_count FROM directory_checkpoint_heads").first(), head);
      assert.equal((await runtime.db.prepare("SELECT next_block FROM directory_checkpoint_heads").first())?.next_block, String(f.state.head));
    }
  } finally { await runtime.dispose(); }
});

test("warm racing readers refuse a stale full-cursor advance while keeping the winner and reused pages", async () => {
  const runtime = await communityRuntime();
  let release!: () => void, arrived!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const atAdvance = new Promise<void>((resolve) => { arrived = resolve; });
  try {
    await prepareDirectoryCache(runtime.db);
    const f = await directoryFixture();
    const cache = directoryHistoryCache(runtime.db, f.client, f.profile);
    await readConfigurationHistory(f.client, f.profile, f.transport, cache);
    const original = await runtime.db.prepare("SELECT * FROM directory_checkpoint_pages").all();
    f.state.head = 150n;
    const slow = { ...cache, async advance(saved: DirectoryCheckpoint, head: bigint, blockHash: Hex) {
      arrived(); await wait; return cache.advance(saved, head, blockHash);
    } };
    const pending = readConfigurationHistory(f.client, f.profile, f.transport, slow);
    const refused = assert.rejects(pending, /directory_cache_cursor_raced/);
    await atAdvance;
    f.state.head = 200n;
    assert.deepEqual(await readConfigurationHistory(f.client, f.profile, f.transport, cache), [f.config]);
    release(); await refused;
    assert.equal((await runtime.db.prepare("SELECT next_block FROM directory_checkpoint_heads").first())?.next_block, "200");
    assert.deepEqual((await runtime.db.prepare("SELECT * FROM directory_checkpoint_pages").all()).results, original.results);
  } finally { release(); await runtime.dispose(); }
});

test("every prior head field binds advance and snapshot replacement, including a reused snapshot race", async () => {
  const runtime = await communityRuntime();
  try {
    await prepareDirectoryCache(runtime.db);
    const f = await directoryFixture(), cache = directoryHistoryCache(runtime.db, f.client, f.profile);
    await readConfigurationHistory(f.client, f.profile, f.transport, cache);
    const saved = await cache.load(99n); assert.ok(saved);
    const before = await runtime.db.prepare("SELECT * FROM directory_checkpoint_heads").first();
    const otherProfile = { ...f.profile, directory: "0x" + "9".repeat(40) as Hex };
    assert.equal(await directoryHistoryCache(runtime.db, f.client, otherProfile).advance(saved, 199n, f.state.hash), false);
    assert.deepEqual(await runtime.db.prepare("SELECT * FROM directory_checkpoint_heads").first(), before);
    for (const changed of [{ snapshot: "b".repeat(64) }, { nextBlock: saved.nextBlock - 1n },
      { blockHash: hash("b") }, { revision: saved.revision + 1 }, { pages: saved.pages + 1 }]) {
      assert.equal(await cache.advance({ ...saved, ...changed }, 199n, f.state.hash), false);
      assert.deepEqual(await runtime.db.prepare("SELECT * FROM directory_checkpoint_heads").first(), before);
    }
    const writer = cache.begin(saved);
    for await (const page of cache.pages(saved)) await writer.append(page);
    assert.equal(await cache.advance(saved, 199n, f.state.hash), true);
    assert.equal(await writer.commit(299n, f.state.hash, saved.revision), false);
    assert.equal((await runtime.db.prepare("SELECT next_block FROM directory_checkpoint_heads").first())?.next_block, "200");
    assert.equal((await runtime.db.prepare("SELECT COUNT(*) n FROM transaction_guards").first())?.n, 0);
  } finally { await runtime.dispose(); }
});

test("lagging, missing and null block views refuse without deleting the checkpoint or its evidence", async () => {
  const runtime = await communityRuntime();
  try {
    await prepareDirectoryCache(runtime.db);
    const f = await directoryFixture(), cache = directoryHistoryCache(runtime.db, f.client, f.profile);
    await readConfigurationHistory(f.client, f.profile, f.transport, cache);
    const before = await runtime.db.prepare("SELECT * FROM directory_checkpoint_heads").first();
    const pages = (await runtime.db.prepare("SELECT * FROM directory_checkpoint_pages").all()).results;
    // The checkpoint block is available, but this caller selected an older view.
    await assert.rejects(cache.load(98n), /directory_cache_view_unavailable/);
    const unavailable = new Error("transport_unavailable");
    for (const fault of ["missing", "null", "wrong-number", "malformed", "transport"] as const) {
      const client = new Proxy(f.client, { get(target, key) {
        if (key === "getBlock") return async (input: Parameters<typeof target.getBlock>[0]) => {
          if (fault === "missing") throw new BlockNotFoundError({ blockNumber: 99n });
          if (fault === "transport") throw unavailable;
          if (fault === "wrong-number") return { ...await target.getBlock(input), number: 98n };
          if (fault === "malformed") return { ...await target.getBlock(input), hash: undefined };
          return { ...await target.getBlock(input), hash: null };
        };
        return Reflect.get(target, key);
      } });
      if (fault === "transport") await assert.rejects(directoryHistoryCache(runtime.db, client, f.profile).load(199n), (error) => error === unavailable);
      else if (fault === "malformed") await assert.rejects(directoryHistoryCache(runtime.db, client, f.profile).load(199n), /invalid_shared_bytes32/);
      else await assert.rejects(directoryHistoryCache(runtime.db, client, f.profile).load(199n), /directory_cache_view_unavailable/);
      assert.deepEqual(await runtime.db.prepare("SELECT * FROM directory_checkpoint_heads").first(), before);
      assert.deepEqual((await runtime.db.prepare("SELECT * FROM directory_checkpoint_pages").all()).results, pages);
    }
    f.state.head = 90n;
    await assert.rejects(readConfigurationHistory(f.client, f.profile, f.transport, cache), /directory_cache_view_unavailable/);
    assert.deepEqual(await runtime.db.prepare("SELECT * FROM directory_checkpoint_heads").first(), before);
  } finally { await runtime.dispose(); }
});

test("proven reorg invalidation compares the complete cursor and cannot delete a concurrently reused snapshot", async () => {
  const runtime = await communityRuntime();
  let release!: () => void, arrived!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const atBlock = new Promise<void>((resolve) => { arrived = resolve; });
  try {
    await prepareDirectoryCache(runtime.db);
    const f = await directoryFixture(), cache = directoryHistoryCache(runtime.db, f.client, f.profile);
    await readConfigurationHistory(f.client, f.profile, f.transport, cache);
    const saved = await cache.load(99n); assert.ok(saved);
    const originalPages = (await runtime.db.prepare("SELECT * FROM directory_checkpoint_pages").all()).results;
    const stale = new Proxy(f.client, { get(target, key) {
      if (key === "getBlock") return async (input: Parameters<typeof target.getBlock>[0]) => {
        const block = await target.getBlock(input); arrived(); await wait; return { ...block, hash: hash("b") };
      };
      return Reflect.get(target, key);
    } });
    const pending = directoryHistoryCache(runtime.db, stale, f.profile).load(199n);
    const refused = assert.rejects(pending, /directory_cache_cursor_raced/);
    await atBlock;
    assert.equal(await cache.advance(saved, 199n, f.state.hash), true);
    release(); await refused;
    assert.equal((await runtime.db.prepare("SELECT next_block FROM directory_checkpoint_heads").first())?.next_block, "200");
    f.state.head = 200n; f.state.hash = hash("b");
    assert.equal(await cache.load(199n), undefined);
    assert.equal((await runtime.db.prepare("SELECT COUNT(*) n FROM directory_checkpoint_heads").first())?.n, 0);
    assert.deepEqual((await runtime.db.prepare("SELECT * FROM directory_checkpoint_pages").all()).results, originalPages);
  } finally { release(); await runtime.dispose(); }
});

test("missing proposed cache schema refuses existing routes without an in-memory or IPFS fallback", async () => {
  const runtime = await communityRuntime();
  try {
    const f = await directoryFixture();
    await assert.rejects(readConfigurationHistory(f.client, f.profile, f.transport,
      directoryHistoryCache(runtime.db, f.client, f.profile)), /no such table.*directory_checkpoint_heads/);
    assert.equal(f.state.downloads, 0);
    assert.equal(f.state.logRanges.length, 0);
  } finally { await runtime.dispose(); }
});
