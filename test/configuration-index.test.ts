import { test } from "node:test";
import assert from "node:assert/strict";
import { communityRuntime } from "./community-runtime.ts";
import { directoryFixture } from "./fixtures/directory-reader.ts";
import { readConfigurationHistory } from "../packages/community/directory-reader.ts";
import { directoryHistoryCache } from "../packages/community/configuration-index.ts";

const hash = (s: string) => `0x${s.repeat(64)}` as const;
test("directory checkpoints survive new request objects; unchanged revisions scan no history even days later", async () => {
  const runtime = await communityRuntime();
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
    await runtime.db
      .prepare("UPDATE public_configurations SET publisher=?")
      .bind("0x" + "9".repeat(40))
      .run();
    await assert.rejects(read(), /directory_cache_event_changed/);
    await runtime.db
      .prepare("UPDATE public_configurations SET publisher=?,manifest_json=?")
      .bind(f.config.publisher, '{"fabricated":true}')
      .run();
    await assert.rejects(read());
  } finally {
    await runtime.dispose();
  }
});
test("concurrent cold readers cannot replace the winner's newer checkpoint with an older snapshot", async () => {
  const runtime = await communityRuntime();
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
      .prepare("SELECT next_block FROM chain_scan_state")
      .first<{ next_block: string }>();
    assert.equal(cursor?.next_block, "200");
    assert.equal(
      (
        await runtime.db
          .prepare("SELECT COUNT(*) AS n FROM public_configurations")
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
          .prepare("SELECT next_block FROM chain_scan_state")
          .first()
      )?.next_block,
      "90",
    );
  } finally {
    await runtime.dispose();
  }
});
