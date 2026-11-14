import { prepareDirectoryCache } from "./fixtures/directory-checkpoint-schema.ts";
import { hashText } from "../packages/community/common.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { communityRuntime } from "./community-runtime.ts";
import { directoryFixture } from "./fixtures/directory-reader.ts";
import { readConfigurationHistory } from "../packages/community/directory-reader.ts";
import { directoryHistoryCache } from "../packages/community/configuration-index.ts";

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
    f.state.head = 90n;
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
