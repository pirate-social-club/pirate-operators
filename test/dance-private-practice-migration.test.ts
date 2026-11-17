// Failure cases FIRST. Pinned Alchemy migrator + actual local workerd D1,
// production capture/source3 stores and guards. Offline configuration/proof
// fixtures are explicit; this does not qualify Directory, account or media access.
import test from "node:test";
import assert from "node:assert/strict";
import { canonical, hashJson } from "../packages/community/common.ts";
import { preparePrivateDanceState } from "../services/dance-private-practice-state.ts";
import { privatePracticeFixture, exercisePrivateStores } from "./dance-private-practice-migration-fixture.ts";

const activate = (f: Awaited<ReturnType<typeof privatePracticeFixture>>, current = async () => {}) =>
  preparePrivateDanceState({ db: f.db, config: f.config, policy: f.policy, policyHash: hashJson(f.policy), current });

test("real Alchemy1..21 to22 preserves first-song/V1 bytes, original triggers and migration ledger", { timeout: 30000 }, async () => {
  const f = await privatePracticeFixture();
  try {
    await f.apply(21); await f.seedRetained();
    const before = await f.retained(), ledger = await f.ledger();
    await f.apply(22);
    assert.deepEqual(await f.retained(), before);
    assert.deepEqual((await f.ledger()).slice(0, 21), ledger);
    assert.equal((await f.ledger()).length, 22);
    assert.equal(await f.db.prepare("SELECT count(*) n FROM setup_schema WHERE version=22").first<number>("n"), 1);
    await assert.rejects(f.db.prepare("UPDATE dance_captures SET request_hash='changed' WHERE capture_id=?").bind(f.legacy.captureId).run(), /dance_capture_immutable/);
    await assert.rejects(f.db.prepare("DELETE FROM dance_consents WHERE capture_id=?").bind(f.legacy.captureId).run(), /dance_consent_immutable/);
    const full = await f.ledger(); await f.apply(22); assert.deepEqual(await f.ledger(), full);
    assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await f.dispose(); }
});

test("empty22 initializes no policy/account/source and actual private stores work only after explicit activation", { timeout: 30000 }, async () => {
  const f = await privatePracticeFixture();
  try {
    await f.apply(22);
    for (const table of ["dance_host_context", "dance_host_accounts", "dance_host_selections", "dance_host_song_keys", "dance_host_audio_probes", "dance_source3_requests"])
      assert.equal(await f.db.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n"), 0);
    await f.seedRetained(); await f.seedVerifiedConfiguration();
    const state = await activate(f);
    assert.equal(state.revision, 1); assert.equal(state.bodyJson, canonical(f.policy));
    const result = await exercisePrivateStores(f);
    assert.equal(result.capture.version, "pirate.dance/2");
    assert.equal(result.capture.publication.kind, "private");
    assert.ok(result.capture.consent);
    assert.equal(await f.db.prepare("SELECT count(*) n FROM dance_source3_requests").first<number>("n"), 1);
    assert.equal(await f.db.prepare("SELECT count(*) n FROM dance_outbox").first<number>("n"), 0);
    assert.equal(await f.db.prepare("SELECT count(*) n FROM dance_host_accounts").first<number>("n"), 0);
    await assert.rejects(f.db.prepare("DELETE FROM dance_source3_requests").run(), /dance_source3_original_retained/);
    await assert.rejects(f.db.prepare("UPDATE dance_source3_requests SET request_id='replacement'").run(), /dance_source3_original_retained/);
    await assert.rejects(f.db.prepare("INSERT OR REPLACE INTO dance_source3_requests SELECT * FROM dance_source3_requests").run(), /dance_source3_original_retained/);
  } finally { await f.dispose(); }
});

test("identical private activation retains original bytes/revision and never resets a generation", { timeout: 30000 }, async () => {
  const f = await privatePracticeFixture();
  try {
    await f.apply(22); await f.seedVerifiedConfiguration();
    const first = await activate(f); assert.equal(first.revision, 1);
    await f.db.prepare("INSERT INTO dance_host_selections VALUES(?,?,'','',1,'{}')").bind(f.config.communityId, f.shape.privateSnapshot.songKey).run();
    await assert.rejects(f.db.prepare("UPDATE dance_host_selections SET body_json='[]'").run(), /dance_host_revision/);
    const next = await activate(f); assert.equal(next.revision, 2); assert.equal(next.bodyJson, first.bodyJson);
    assert.equal(next.policyHash, first.policyHash);
    await assert.rejects(preparePrivateDanceState({ db: f.db, config: f.config,
      policy: { ...f.policy, rulesEpoch: f.policy.rulesEpoch + 1 }, policyHash: hashJson({ ...f.policy, rulesEpoch: f.policy.rulesEpoch + 1 }), current: () => {} }), /policy_changed/);
    assert.equal((await activate(f)).revision, 2);
    await assert.rejects(f.db.prepare("DELETE FROM dance_host_context").run(), /dance_host_context_retained/);
    await assert.rejects(f.db.prepare("INSERT OR REPLACE INTO dance_host_context SELECT * FROM dance_host_context").run(), /dance_host_context_retained/);
  } finally { await f.dispose(); }
});

for (const failure of ["missing identity", "foreign identity", "missing configuration", "wrong hash", "wrong JSON", "wrong publisher", "later configuration", "wrong policy hash", "wrong policy revision", "old V4 context"] as const)
  test(`activation refuses ${failure} without replacing or enabling policy`, { timeout: 30000 }, async () => {
    const f = await privatePracticeFixture();
    try {
      await f.apply(22); await f.seedVerifiedConfiguration();
      if (failure === "missing identity") await f.db.prepare("DELETE FROM application_identity").run();
      if (failure === "foreign identity") await f.db.prepare("UPDATE application_identity SET community_origin='https://foreign.invalid'").run();
      if (failure === "missing configuration") await f.db.prepare("DELETE FROM public_configurations").run();
      if (failure === "wrong hash") await f.db.prepare("UPDATE public_configurations SET manifest_sha256=?").bind("0x" + "ef".repeat(32)).run();
      if (failure === "wrong JSON") await f.db.prepare("UPDATE public_configurations SET manifest_json='{}'").run();
      if (failure === "wrong publisher") await f.db.prepare("UPDATE public_configurations SET publisher=?").bind("0x" + "ab".repeat(20)).run();
      if (failure === "later configuration") await f.seedLaterConfiguration();
      if (failure === "old V4 context") await f.db.prepare("INSERT INTO dance_host_context VALUES(?,7,?)").bind(f.config.communityId, canonical({ version: "pirate.dance-host-context/1", sourceHash: "0x" + "11".repeat(32) })).run();
      const before = (await f.db.prepare("SELECT * FROM dance_host_context").all()).results;
      await assert.rejects(preparePrivateDanceState({ db: f.db, config: f.config,
        policy: failure === "wrong policy revision" ? { ...f.policy, configurationRevision: f.policy.configurationRevision + 1 } : f.policy,
        policyHash: failure === "wrong policy hash" ? "0x" + "ef".repeat(32) : hashJson(f.policy), current: () => {} }));
      assert.deepEqual((await f.db.prepare("SELECT * FROM dance_host_context").all()).results, before);
      assert.equal(await f.db.prepare("SELECT count(*) n FROM dance_transaction_guards").first<number>("n"), 0);
    } finally { await f.dispose(); }
  });

test("changed Root selection after await refuses before the accepting policy insert", { timeout: 30000 }, async () => {
  const f = await privatePracticeFixture();
  try {
    await f.apply(22); await f.seedVerifiedConfiguration();
    let selection = "original";
    const db = f.observeReads(() => { selection = "replaced"; });
    await assert.rejects(preparePrivateDanceState({ db, config: f.config, policy: f.policy, policyHash: hashJson(f.policy),
      current: () => { assert.equal(selection, "original", "Root selected profile changed"); } }));
    assert.equal(await f.db.prepare("SELECT count(*) n FROM dance_host_context").first<number>("n"), 0);
  } finally { await f.dispose(); }
});

for (const loss of ["identity", "configuration", "later configuration"] as const)
  test(`actual accepting D1 transaction refuses last-moment ${loss} loss`, { timeout: 30000 }, async () => {
    const f = await privatePracticeFixture();
    try {
      await f.apply(22); await f.seedVerifiedConfiguration();
      const db = f.beforeBatch(async () => {
        if (loss === "identity") await f.db.prepare("DELETE FROM application_identity").run();
        else if (loss === "configuration") await f.db.prepare("DELETE FROM public_configurations").run();
        else await f.seedLaterConfiguration();
      });
      await assert.rejects(preparePrivateDanceState({ db, config: f.config, policy: f.policy, policyHash: hashJson(f.policy), current: () => {} }), /dance_fence_changed/);
      assert.equal(await f.db.prepare("SELECT count(*) n FROM dance_host_context").first<number>("n"), 0);
      assert.equal(await f.db.prepare("SELECT count(*) n FROM dance_transaction_guards").first<number>("n"), 0);
    } finally { await f.dispose(); }
  });

test("actual Alchemy migration22 DDL and ledger roll back together on a failed batch", { timeout: 30000 }, async () => {
  const f = await privatePracticeFixture();
  try {
    await f.apply(21); const ledger = await f.ledger();
    await assert.rejects(f.applyBroken22(), /fixture_missing_private_dance_table/);
    assert.deepEqual(await f.ledger(), ledger);
    assert.equal(await f.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name='dance_host_context'").first<number>("n"), 0);
    await f.apply(22);
    assert.equal((await f.ledger()).length, 22);
  } finally { await f.dispose(); }
});

test("migration22 refuses a conflicting pre-existing host schema instead of silently accepting it", { timeout: 30000 }, async () => {
  const f = await privatePracticeFixture();
  try {
    await f.apply(21);
    await f.db.prepare("CREATE TABLE dance_host_context (unreviewed TEXT)").run();
    const ledger = await f.ledger();
    await assert.rejects(f.apply(22), /already exists/);
    assert.deepEqual(await f.ledger(), ledger);
    assert.equal(await f.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name='dance_source3_requests'").first<number>("n"), 0);
  } finally { await f.dispose(); }
});


test("lost activation acknowledgement preserves the original canonical policy and duplicate recovers it", { timeout: 30000 }, async () => {
  const f = await privatePracticeFixture();
  try {
    await f.apply(22); await f.seedVerifiedConfiguration();
    let lost = false;
    const db = new Proxy(f.db, { get(t, key) {
      if (key === "batch") return async (...args: Parameters<D1Database["batch"]>) => {
        const result = await t.batch(...args);
        if (!lost) { lost = true; throw Error("fixture_lost_policy_ack"); }
        return result;
      };
      const value = Reflect.get(t, key); return typeof value === "function" ? value.bind(t) : value;
    } });
    await assert.rejects(preparePrivateDanceState({ db, config: f.config, policy: f.policy, policyHash: hashJson(f.policy), current: () => {} }), /fixture_lost_policy_ack/);
    const original = await f.db.prepare("SELECT revision,body_json FROM dance_host_context WHERE community_id=?").bind(f.config.communityId).first<{ revision: number; body_json: string }>();
    assert.ok(original); assert.equal(original.revision, 1);
    const recovered = await activate(f);
    assert.equal(recovered.revision, original.revision); assert.equal(recovered.bodyJson, original.body_json);
  } finally { await f.dispose(); }
});
