import test from "node:test";
import assert from "node:assert/strict";
import { decodeEventLog } from "viem";
import { directoryAbi } from "../packages/community/directory-wire.ts";
import { directoryFixture } from "./fixtures/directory-reader.ts";
import { communityRuntime } from "./community-runtime.ts";
import { prepareDirectoryCache } from "./fixtures/directory-checkpoint-schema.ts";
import { directoryHistoryCache } from "../packages/community/configuration-index.ts";
import { readConfiguration, readConfigurationHistory } from "../packages/community/directory-reader.ts";
import { configurationState, validateConfiguration } from "../packages/community/config-manifest.ts";

test("513 revisions cross 256, checkpoint page boundaries, cold replay and process-local cache recreation", async () => {
  const runtime = await communityRuntime();
  try {
    await prepareDirectoryCache(runtime.db);
    const f = await directoryFixture();
    for (let i = 1; i < 513; i++) { f.state.head += 2n; await f.extend(); }
    assert.equal((await f.read()).configurationRevision, 513);
    const read = () => readConfiguration(f.client, f.profile, f.transport, directoryHistoryCache(runtime.db, f.client, f.profile));
    assert.equal((await read()).configurationRevision, 513);
    const downloads = f.state.downloads, scans = f.state.logRanges.length;
    assert.equal((await read()).configurationRevision, 513);
    assert.equal(f.state.downloads, downloads);
    assert.equal(f.state.logRanges.length, scans);
    f.state.head += 2n; await f.extend();
    assert.equal((await read()).configurationRevision, 514);
    assert.equal(f.state.downloads, downloads + 1);
    const pages = await runtime.db.prepare("SELECT page_count FROM directory_checkpoint_heads").first<{ page_count: number }>();
    assert.equal(pages?.page_count, 65);
  } finally { await runtime.dispose(); }
});

test("a missing revision at 257 fails; it never publishes a partial durable head", async () => {
  const runtime = await communityRuntime();
  try {
    await prepareDirectoryCache(runtime.db);
    const f = await directoryFixture();
    for (let i = 1; i < 260; i++) { f.state.head += 2n; await f.extend(); }
    const broken = new Proxy(f.client, { get(target, key) {
      if (key === "getLogs") return async (input: Parameters<typeof target.getLogs>[0]) =>
        (await target.getLogs(input)).filter((log) => decodeEventLog({
          abi: directoryAbi, eventName: "ConfigurationPublished", data: log.data, topics: log.topics,
        }).args.revision !== 257n);
      return Reflect.get(target, key);
    } });
    await assert.rejects(readConfigurationHistory(broken, f.profile, f.transport,
      directoryHistoryCache(runtime.db, broken, f.profile)), /configuration_history_conflict/);
    assert.equal((await runtime.db.prepare("SELECT COUNT(*) n FROM directory_checkpoint_heads").first())?.n, 0);
    assert.equal((await readConfiguration(f.client, f.profile, f.transport,
      directoryHistoryCache(runtime.db, f.client, f.profile))).configurationRevision, 260);
  } finally { await runtime.dispose(); }
});

test("a missing immutable page refuses reload; a stored revision never substitutes for its evidence", async () => {
  const runtime = await communityRuntime();
  try {
    await prepareDirectoryCache(runtime.db);
    const f = await directoryFixture();
    for (let i = 1; i < 17; i++) { f.state.head += 2n; await f.extend(); }
    const read = () => readConfiguration(f.client, f.profile, f.transport, directoryHistoryCache(runtime.db, f.client, f.profile));
    await read();
    await runtime.db.prepare("DELETE FROM directory_checkpoint_pages WHERE page_number=1").run();
    await assert.rejects(read(), /directory_cache_page_changed/);
  } finally { await runtime.dispose(); }
});

test("cold history authenticates receipts, not only RPC logs and manifest hashes", async () => {
  const f = await directoryFixture();
  const broken = new Proxy(f.client, { get(target, key) {
    if (key === "getTransactionReceipt") return async (input: Parameters<typeof target.getTransactionReceipt>[0]) =>
      ({ ...await target.getTransactionReceipt(input), status: "reverted" });
    return Reflect.get(target, key);
  } });
  await assert.rejects(readConfiguration(broken, f.profile, f.transport), /directory_cache_provenance_changed/);
});

test("cumulative publisher revocation survives revision 256 and cannot be removed or reused", async () => {
  const f = await directoryFixture(), state = configurationState();
  validateConfiguration(f.config, state, 51n);
  const next = { ...f.config, publisher: "0x" + "7".repeat(40), publisherRevocations: [
    { postsContract: f.config.postsContract, publisher: f.config.publisher, fromBlock: "51" },
  ] };
  for (let revision = 2; revision <= 257; revision++) validateConfiguration({ ...next, configurationRevision: revision }, state, 500n);
  assert.throws(() => validateConfiguration({ ...next, configurationRevision: 258, publisherRevocations: [] }, state, 500n), /revocation_removed_or_changed/);
  assert.throws(() => validateConfiguration({ ...next, configurationRevision: 258, publisher: f.config.publisher }, state, 500n), /publisher_is_revoked/);
  assert.equal(state.last?.configurationRevision, 257);
});

test("interrupted page durability cannot move the head; restart reuses only the original canonical history", async () => {
  const runtime = await communityRuntime();
  try {
    await prepareDirectoryCache(runtime.db);
    const f = await directoryFixture();
    await readConfiguration(f.client, f.profile, f.transport, directoryHistoryCache(runtime.db, f.client, f.profile));
    const old = await runtime.db.prepare("SELECT snapshot FROM directory_checkpoint_heads").first();
    for (let i = 1; i < 20; i++) { f.state.head += 2n; await f.extend(); }
    let writes = 0;
    const failing = new Proxy(runtime.db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.startsWith("INSERT INTO directory_checkpoint_pages") && ++writes === 2) throw new Error("simulated_page_write_failure");
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await assert.rejects(readConfiguration(f.client, f.profile, f.transport, directoryHistoryCache(failing, f.client, f.profile)), /page_write_failure/);
    assert.deepEqual(await runtime.db.prepare("SELECT snapshot FROM directory_checkpoint_heads").first(), old);
    assert.equal((await readConfiguration(f.client, f.profile, f.transport,
      directoryHistoryCache(runtime.db, f.client, f.profile))).configurationRevision, 20);
  } finally { await runtime.dispose(); }
});
