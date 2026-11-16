import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { Miniflare } from "miniflare";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, digest } from "../packages/protocol/index.ts";
import { preparePublicationGrant } from "../packages/protocol/publication-consent.ts";
import type { ConsentSourceV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { sourceId } from "../services/publication-command-contract.ts";
import {
  acceptCommandSignature,
  beginCommand,
  ownedCommand,
  publicHead,
  saveObservation,
  savePrepared,
  type CommandSeed,
} from "../services/publication-command-store.ts";

// Public disposable fixture key; never a managed or funded public-chain key.
const learner = privateKeyToAccount(`0x${"61".repeat(32)}`);
const selected: ConsentSourceV1 = {
  schema: "pirate.publication-source/1", resultsVersion: 5, chainId: 31337,
  communityId: digest("command-community"), installationId: "fixture-installation",
  directory: `0x${"11".repeat(20)}`, directoryRuntimeHash: digest("directory-code"),
  registry: `0x${"22".repeat(20)}`, registryRuntimeHash: digest("registry-code"),
  releaseSelectionSha256: digest("reviewed-selection"),
};
const owner = { communityId: selected.communityId, accountId: "fixture-account" };
const maxCounter = 9007199254740991;

async function fixture(t: TestContext) {
  const runtime = new Miniflare({ modules: true,
    script: "export default {fetch(){return new Response('journal fixture')}}",
    compatibilityDate: "2026-08-06", d1Databases: ["DB"] });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  const sql = await readFile(new URL(
    "../packages/community/schema/publication-consent.sql", import.meta.url), "utf8");
  await db.batch(sql.replace(/^--.*$/gm, "").split(/;\s*(?=CREATE\s|$)/)
    .map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  const seed: CommandSeed = {
    source: selected, accountId: owner.accountId, requestId: "request-1",
    purpose: "study-results", action: "grant", nonce: digest("first-nonce"),
    nowMs: 1800000000000, capture: { beta: 2, alpha: 1 },
  };
  return { db, seed };
}
const message = (nonce: string) => ({
  learner: learner.address.toLowerCase(), communityId: selected.communityId,
  purpose: "study-results", publicationTarget: selected.registry,
  publicationTargetRuntimeHash: selected.registryRuntimeHash,
  permissionRevision: "1", policyHash: digest("study-policy"), withdrawalEpoch: "0",
  nonce, issuedAt: "1800000000", validAfter: "1800000000",
  expiresAt: "1800003600", submitBefore: "1800000060",
});

test("actual D1 stages one canonical command and first nonce under competing replays", async t => {
  const { db, seed } = await fixture(t);
  const rows = await Promise.all([beginCommand(db, seed), beginCommand(db, {
    ...seed, nonce: digest("losing-nonce"), capture: { alpha: 1, beta: 2 },
  }), beginCommand(db, { ...seed, nonce: digest("another-losing-nonce") })]);
  assert.equal(new Set(rows.map(r => r.command_id)).size, 1);
  assert.equal(new Set(rows.map(r => r.nonce_hex)).size, 1);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM publication_v1_commands")
    .first<{ n: number }>())!.n, 1);
  assert.equal(rows[0].request_json, canonical(JSON.parse(rows[0].request_json)));
  const original = await ownedCommand(db, rows[0].command_id, owner);
  await assert.rejects(beginCommand(db, { ...seed, capture: { changed: true } }),
    /publication_command_changed/);
  assert.deepEqual(await ownedCommand(db, original.command_id, owner), original);
  assert.deepEqual(await publicHead(db, original), { generation: 0, stopped: 1, dirty: 0 });
  t.diagnostic(JSON.stringify({ artifact: "publication-command-d1/1",
    commandId: original.command_id, requestHash: original.request_hash,
    stagedCommands: 1, payerNonceAllocations: "not-attached" }));
});

test("withdrawal retry after a lost post-batch read retains one fence generation and nonce", async t => {
  const { db, seed } = await fixture(t);
  let loseRead = true;
  const interrupted = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      if (!/^SELECT \* FROM publication_v1_commands/.test(sql)) return statement;
      return { bind: (...values: unknown[]) => {
        const bound = statement.bind(...values);
        return { first: async () => {
          if (loseRead) { loseRead = false; throw Error("lost post-batch read"); }
          return bound.first();
        } };
      } };
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const withdrawal = { ...seed, action: "withdraw" as const };
  await assert.rejects(beginCommand(interrupted, withdrawal), /lost post-batch read/);
  const copies = await Promise.all([beginCommand(db, withdrawal),
    beginCommand(db, { ...withdrawal, nonce: digest("unused-retry-nonce") })]);
  assert.equal(copies[0].nonce_hex, seed.nonce);
  assert.equal(copies[0].command_id, copies[1].command_id);
  assert.equal(copies[0].fence_generation, 1);
  assert.deepEqual(await publicHead(db, copies[0]), { generation: 1, stopped: 1, dirty: 1 });
  await assert.rejects(db.prepare("UPDATE publication_v1_heads SET generation=0").run(),
    /publication_head_regression/);
  await assert.rejects(db.prepare("DELETE FROM publication_v1_heads").run(),
    /publication_head_immutable/);
  assert.deepEqual(await publicHead(db, copies[0]), { generation: 1, stopped: 1, dirty: 1 });
});

test("a withdrawal racing preparation prevents stale grant bytes from being saved", async t => {
  const { db, seed } = await fixture(t);
  const pending = await beginCommand(db, seed);
  await beginCommand(db, { ...seed, action: "withdraw", requestId: "withdraw-1" });
  await assert.rejects(savePrepared(db, pending, message(pending.nonce_hex), seed.nowMs),
    /publication_prepare_changed/);
  const retained = await ownedCommand(db, pending.command_id, owner);
  assert.equal(retained.phase, "preparing");
  assert.equal(retained.typed_json, null);
  assert.equal(retained.digest, null);
});

test("first signature/envelope survive replay and stale observations cannot replace newer history", async t => {
  const { db, seed } = await fixture(t);
  const staged = await beginCommand(db, seed);
  const grant = message(staged.nonce_hex);
  const prepared = await savePrepared(db, staged, grant, seed.nowMs);
  assert.ok(prepared.typed_json);
  const typed = preparePublicationGrant(31337n, selected.registry, grant, "0x");
  const signature = await learner.signTypedData(typed.typed);
  const envelope = { command: JSON.parse(prepared.typed_json), signature };
  const accepted = await acceptCommandSignature(db, prepared, signature, envelope, seed.nowMs);
  assert.deepEqual(await acceptCommandSignature(db, prepared, signature, envelope, seed.nowMs), accepted);
  await assert.rejects(acceptCommandSignature(db, prepared, "0x1234",
    { ...envelope, signature: "0x1234" }, seed.nowMs), /publication_command_changed/);
  assert.equal((await ownedCommand(db, accepted.command_id, owner)).signature, signature);
  const unknown = await saveObservation(db, accepted, { state: "unknown", original: typed.digest }, seed.nowMs);
  await assert.rejects(saveObservation(db, accepted,
    { state: "recorded", original: typed.digest }, seed.nowMs), /publication_observation_raced/);
  const current = await ownedCommand(db, accepted.command_id, owner);
  assert.equal(current.observation_hash, unknown.observation_hash);
  assert.equal(current.result_state, "unknown");
  assert.equal((await db.prepare("SELECT count(*) AS n FROM publication_v1_observations")
    .first<{ n: number }>())!.n, 2);
});

test("stable source identity preserves withdrawal scope across installation and release changes", () => {
  assert.equal(sourceId(selected), sourceId({ ...selected,
    installationId: "replacement-installation", releaseSelectionSha256: digest("new-release"),
    directory: `0x${"33".repeat(20)}`, directoryRuntimeHash: digest("new-directory") }));
  assert.notEqual(sourceId(selected), sourceId({ ...selected, chainId: 6343 }));
  assert.notEqual(sourceId(selected), sourceId({ ...selected, registryRuntimeHash: digest("new-registry") }));
});

test("the database preserves original identity, first accepted bytes and append-only observations", async t => {
  const { db, seed } = await fixture(t);
  const staged = await beginCommand(db, seed);
  const prepared = await savePrepared(db, staged, message(staged.nonce_hex), seed.nowMs);
  assert.ok(prepared.typed_json);
  const typed = preparePublicationGrant(31337n, selected.registry,
    message(staged.nonce_hex), "0x");
  const signature = await learner.signTypedData(typed.typed);
  const accepted = await acceptCommandSignature(db, prepared, signature,
    { command: JSON.parse(prepared.typed_json), signature }, seed.nowMs);
  const observed = await saveObservation(db, accepted,
    { state: "unknown", original: typed.digest }, seed.nowMs);
  // Exercise SQLite's persisted boundary rather than only the service CAS.
  for (const [column, value] of [
    ["request_json", "{}"], ["request_hash", digest("replacement")],
    ["nonce_hex", digest("replacement-nonce")], ["account_id", "another-account"],
    ["fence_generation", 9], ["typed_json", "{}"], ["digest", digest("replacement-digest")],
    ["signature", "0x1234"], ["accepted_json", "{}"], ["phase", "preparing"],
    ["version", observed.version - 1],
  ] as const) {
    await assert.rejects(db.prepare(`UPDATE publication_v1_commands SET ${column}=? WHERE command_id=?`)
      .bind(value, observed.command_id).run(), /publication_.*immutable|publication_.*regression/);
    assert.deepEqual(await ownedCommand(db, observed.command_id, owner), observed);
  }
  await assert.rejects(db.prepare("UPDATE publication_v1_observations SET value_json='{}'").run(),
    /publication_observation_immutable/);
  await assert.rejects(db.prepare("DELETE FROM publication_v1_observations").run(),
    /publication_observation_immutable/);
  await assert.rejects(db.prepare("DELETE FROM publication_v1_commands WHERE command_id=?")
    .bind(observed.command_id).run(), /publication_command_immutable/);
  // REPLACE can perform an implicit delete without DELETE triggers. Protect
  // originals independently of the connection's recursive_triggers setting.
  t.diagnostic(JSON.stringify({ artifact: "publication-command-sqlite-setting/1",
    recursiveTriggers: await db.prepare("PRAGMA recursive_triggers").first() }));
  const replace = async (statement: D1PreparedStatement) => {
    try { await statement.run(); }
    catch (error) { assert.match(String(error), /publication_.*immutable/); }
  };
  const columns = Object.keys(observed);
  const replacement = { ...observed, request_json: "{}" };
  await replace(db.prepare(`INSERT OR REPLACE INTO publication_v1_commands
    (${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
    .bind(...columns.map(k => replacement[k as keyof typeof replacement])));
  assert.deepEqual(await ownedCommand(db, observed.command_id, owner), observed);
  const otherId = { ...observed, command_id: digest("conflicting-identity") };
  await replace(db.prepare(`INSERT OR REPLACE INTO publication_v1_commands
    (${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
    .bind(...columns.map(k => otherId[k as keyof typeof otherId])));
  assert.deepEqual(await ownedCommand(db, observed.command_id, owner), observed);
  await assert.rejects(ownedCommand(db, otherId.command_id, owner), /publication_command_missing/);
  await replace(db.prepare(`INSERT OR REPLACE INTO publication_v1_observations
    (command_id,proof_hash,value_json) VALUES(?,?,'{}')`)
    .bind(observed.command_id, observed.observation_hash));
  await replace(db.prepare(`INSERT OR REPLACE INTO publication_v1_heads
    (community_id,account_id,source_id,purpose,generation,stopped)
    VALUES(?,?,?,?,9,0)`).bind(observed.community_id, observed.account_id,
      observed.source_id, observed.purpose));
  assert.deepEqual(await publicHead(db, observed), { generation: 0, stopped: 1, dirty: 0 });
  const proofs = await db.prepare("SELECT value_json FROM publication_v1_observations").all<{value_json:string}>();
  assert.deepEqual(proofs.results.map(p => JSON.parse(p.value_json)),
    [{ state: "unknown", original: typed.digest }]);
});

test("generation exhaustion keeps the pending withdrawal while historical command reads survive counter exhaustion", async t => {
  const { db, seed } = await fixture(t);
  const original = await beginCommand(db, seed);
  const grant = message(original.nonce_hex);
  const prepared = await savePrepared(db, original, grant, seed.nowMs);
  assert.ok(prepared.typed_json);
  const typed = preparePublicationGrant(31337n, selected.registry, grant, "0x");
  const signature = await learner.signTypedData(typed.typed);
  const accepted = await acceptCommandSignature(db, prepared, signature,
    { command: JSON.parse(prepared.typed_json), signature }, seed.nowMs);
  const recorded = await saveObservation(db, accepted,
    { state: "recorded", original: typed.digest }, seed.nowMs);
  await db.prepare("UPDATE publication_v1_heads SET generation=?,stopped=0")
    .bind(maxCounter).run();
  await assert.rejects(beginCommand(db, { ...seed, action: "withdraw", requestId: "last-withdrawal" }),
    /publication_fence_pending/);
  const pending = await db.prepare("SELECT fence_generation,phase FROM publication_v1_commands WHERE action='withdraw'")
    .first<{ fence_generation: number | null; phase: string }>();
  assert.deepEqual(pending, { fence_generation: null, phase: "preparing" });
  await assert.rejects(publicHead(db, original), /publication_head_unavailable/);
  // Seed only the counter boundary on an otherwise legitimately staged record.
  await db.prepare("UPDATE publication_v1_commands SET version=? WHERE command_id=?")
    .bind(maxCounter, recorded.command_id).run();
  const historical = await ownedCommand(db, recorded.command_id, owner);
  assert.equal(historical.result_state, "recorded");
  assert.equal(historical.version, maxCounter);
  await assert.rejects(saveObservation(db, historical,
    { state: "reverted", original: typed.digest }, seed.nowMs));
  assert.deepEqual(await ownedCommand(db, recorded.command_id, owner), historical);
});
