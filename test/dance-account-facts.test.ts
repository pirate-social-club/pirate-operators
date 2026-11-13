/** UNRUN. Actual SQLite + original parser/hash/production readers. Stored facts,
 * recorded-signature admission and RPC are named fixture inputs, not provider proof. */
import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { getAddress, hashMessage, keccak256, type Hex, type Address } from "viem";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { danceAccountCommitment, danceSingletonId, danceSourceHash } from "../packages/dance-chain/wire.ts";
import { signInMessageV4 } from "../packages/protocol/learning-results-v4.ts";
import { DANCE_PRIVATE_MEDIA_POLICY } from "../packages/dance/contracts.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { UNREGISTERED_OWNER_POLICY_VERSION, UNREGISTERED_OWNER_POLICY_HASH } from "../packages/community/owner-policy.ts";
import { createDanceAccountFacts } from "../services/dance-account-facts.ts";
import { DANCE_HOST_INPUTS_SCHEMA_PROPOSAL, joinDanceFences, type DanceHostContext } from "../services/dance-account-facts-store.ts";
import { MemorySqliteD1 } from "./dance-sqlite-fixture.ts";
import { dh, dw } from "./dance-fixture.ts";

/** Future Root-gated REAL local D1/workerd execution, not a parameter-limit
 * simulation. The 101-bind canary must fail in that engine; never turn a
 * canary failure into a pass via a memory adapter or a transport clamp. */
async function genuineD1(seed: MemorySqliteD1) {
  const mf = new Miniflare({ modules: true,
    script: "export default { fetch() { return new Response('D1 test fixture'); } }",
    d1Databases: ["DB"], d1Persist: false });
  try {
    const native = await mf.getD1Database("DB");
    const canary = (n: number) => native.prepare("SELECT " +
      Array.from({ length: n }, (_, i) => "? AS p" + i).join(",")).bind(...Array.from({ length: n }, (_, i) => i)).all();
    await canary(100);
    await assert.rejects(async () => canary(101), /parameter|variable|bind|limit/i);
    const schema = seed.sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
      .all() as { type: string; name: string; sql: string }[];
    const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
    for (const item of schema.filter(s => s.type === "table")) await native.prepare(item.sql).run();
    // Snapshot an explicit fixture's existing bytes, with triggers installed
    // afterwards so imported head/generation values are neither reset nor replayed.
    for (const table of schema.filter(s => s.type === "table")) {
      const rows = seed.sqlite.prepare("SELECT * FROM " + quote(table.name)).all();
      for (const row of rows) {
        const keys = Object.keys(row), values = Object.values(row);
        await native.prepare("INSERT INTO " + quote(table.name) + "(" + keys.map(quote).join(",") +
          ") VALUES(" + keys.map(() => "?").join(",") + ")").bind(...values).run();
      }
    }
    for (const item of schema.filter(s => s.type !== "table")) await native.prepare(item.sql).run();
    const binds: number[] = [];
    // Observe counts while forwarding native D1 statements/results unchanged.
    const observed = new Proxy(native, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const stmt = target.prepare(sql);
        return new Proxy(stmt, { get(statement, key) {
          if (key === "bind") return (...values: unknown[]) => {
            binds.push(values.length); return statement.bind(...values);
          };
          const member = Reflect.get(statement, key);
          return typeof member === "function" ? member.bind(statement) : member;
        } });
      };
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    } });
    return { db: observed as unknown as D1Database, binds, dispose: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}

/** Explicit fixture projections/RPC, never production seed data or chain proof. */
function hostSimulation() {
  const db = new MemorySqliteD1();
  db.sqlite.exec("CREATE TABLE setup_schema(version INTEGER)");
  for (const name of ["0002_first_song.sql", "0013_learning_authorization.sql", "0018_learning_authority.sql"])
    db.sqlite.exec(readFileSync(new URL("../apps/community-wizard/infra/migrations/" + name, import.meta.url), "utf8"));
  db.sqlite.exec(readFileSync(new URL("../packages/dance/schema.sql", import.meta.url), "utf8"));
  db.sqlite.exec(DANCE_HOST_INPUTS_SCHEMA_PROPOSAL);
  db.sqlite.exec("CREATE TABLE host_fixture_acceptance(id TEXT PRIMARY KEY)");
  const origin = "https://community.invalid", code = "0x6000" as Hex;
  const domain = { chainId: 6343n, communityId: dh(1) as Hex, verifier: dw(20) as Address };
  const rulesDocument = "fixture rules", rubricText = "fixture categorical inspection";
  const mediaPolicyDocument = canonical(DANCE_PRIVATE_MEDIA_POLICY), terms = "fixture private consent";
  const pin = { directory: dw(21) as Address, directoryRuntimeHash: keccak256(code), v4: dw(22) as Address,
    v4RuntimeHash: keccak256(code), posts: dw(23) as Address, postsRuntimeHash: keccak256(code),
    fixedPublisher: dw(24) as Address, publicityPolicyHash: dh(25) as Hex, rulesSha256: hashText(rulesDocument),
    termsSha256: hashText(terms), rubricSha256: hashText(rubricText), mediaPolicySha256: hashText(mediaPolicyDocument),
    runtimeCodeHash: keccak256(code), deploymentBlock: 1n };
  const source: DanceCanonicalSource = { schema: "pirate.dance-verdict/1", domain, pin,
    sourceHash: danceSourceHash(domain, pin), capturePolicy: dw(26) as Address, capturePolicyRuntimeHash: keccak256(code) };
  const config: CommunityConfig = { schema: "pirate.community-config/1", chainId: 6343, directory: pin.directory,
    communityId: domain.communityId, registry: dw(27) as Address, tld: "fixture", configurationRevision: 1,
    postsContract: pin.posts, controller: dw(28) as Address, publisher: pin.fixedPublisher,
    operatorPayments: dw(29) as Address, learningRecords: pin.v4, app: { label: "fixture",
      tokenGeneration: "0", origin, httpsAlias: null, hnsIngress: "none" },
    feed: { endpoint: origin + "/feed", signingKeyId: "fixture" },
    policies: { admission: { version: UNREGISTERED_OWNER_POLICY_VERSION, sha256: UNREGISTERED_OWNER_POLICY_HASH },
      moderationSigner: dw(30) as Address }, publisherRevocations: [] };
  const now = Date.now();
  const context: DanceHostContext = { version: "pirate.dance-host-context/1", sourceHash: source.sourceHash,
    configurationRevision: 1, ownerEpoch: 1, rulesEpoch: 0, mediaEpoch: 0,
    owner: { accountId: "owner", wallet: dw(3), assignmentId: "assignment-original",
      validFromMs: now - 60000, expiresAtMs: now + 86400000 }, captureTtlMs: 600000,
    consent: { version: "fixture-consent", termsHash: pin.termsSha256,
      publicityPolicyHash: pin.publicityPolicyHash, text: terms, admission: "admitted" },
    rulesDocument, rubricText, mediaPolicyDocument };
  db.sqlite.prepare("INSERT INTO application_identity VALUES(1,?,?)").run(domain.communityId, origin);
  db.sqlite.prepare("INSERT INTO public_configurations VALUES(?,1,?,?,?,?,?,?,?)")
    .run(domain.communityId, config.publisher, "fixture-config-uri", hashJson(config), canonical(config), "90", dh(88), dh(89));
  db.sqlite.prepare("INSERT INTO dance_host_context VALUES(?,1,?)").run(domain.communityId, JSON.stringify(context));
  const ids = ["actor", "learner", "owner", "alias"], originals = new Map<string, string>();
  for (const [i, id] of ids.entries()) {
    const subject = dw(i + 1) as Address, binding = "binding-" + id;
    db.sqlite.prepare("INSERT INTO community_accounts VALUES(?,?,?)").run(id, dh(100 + i), now);
    db.sqlite.prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)").run(binding, id, subject, now);
    db.sqlite.prepare("INSERT INTO learning_authority_heads(account_id) VALUES(?)").run(id);
    const signIn = { learner: getAddress(subject), nonce: dh(200 + i) as Hex, issuedAt: BigInt(Math.floor(now / 1000) - 10) };
    const message = signInMessageV4({ origin, communityId: domain.communityId, chainId: 6343,
      contract: pin.v4, publicationPolicy: dh(250) as Hex }, signIn);
    const authorizationId = hashMessage(message);
    originals.set(id, authorizationId);
    db.sqlite.prepare(`INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,
      policy_hash,policy_version,issued_at,state,tx_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,4,?,'recorded',?,?,?)`).run(authorizationId, id, subject,
      JSON.stringify({ learner: signIn.learner, nonce: signIn.nonce, issuedAt: String(signIn.issuedAt) }), message,
      "0x" + "11".repeat(65), dh(250), Number(signIn.issuedAt), dh(300 + i), now, now);
    const commitment = danceAccountCommitment(domain, id, subject);
    const selection = { version: "pirate.dance-account-selection/1", sourceHash: source.sourceHash,
      bindingId: binding, authorizationId, identityEpoch: 1, groupId: danceSingletonId(domain, commitment),
      groupEpoch: 1, knownAliases: [id], active: true };
    db.sqlite.prepare("INSERT INTO dance_host_accounts VALUES(?,?,1,?)").run(domain.communityId, id, JSON.stringify(selection));
  }
  const accountFacts = createDanceAccountFacts({ db: db.asD1(), source, config });
  function change(table: "dance_host_context" | "dance_host_accounts", accountId: string | null,
    use: (body: Record<string, any>) => void) {
    const where = accountId === null ? "community_id=?" : "community_id=? AND account_id=?";
    const keys = accountId === null ? [domain.communityId] : [domain.communityId, accountId];
    const row = db.sqlite.prepare("SELECT body_json FROM " + table + " WHERE " + where).get(...keys)!;
    const body = JSON.parse(String(row.body_json)); use(body);
    db.sqlite.prepare("UPDATE " + table + " SET revision=revision+1,body_json=? WHERE " + where)
      .run(JSON.stringify(body), ...keys);
  }
  return { db, source, config, context, originals, accountFacts, change, code,
    store: new DanceStore(db.asD1()), close: () => db.close() };
}

test("actual private IDs/bound wallet/exact retained V4 original; public or wallet IDs cannot substitute", async () => {
  const f = hostSimulation();
  try {
    const result = await f.accountFacts(f.source.domain.communityId, "actor", "learner");
    assert.equal(result.actor.accountId, "actor"); assert.equal(result.actor.wallet, dw(1));
    assert.equal(result.actor.authorizationId, f.originals.get("actor"));
    assert.equal(result.learner.accountId, "learner");
    assert.equal(result.owner.accountId, "owner"); assert.equal(result.owner.assignmentId, "assignment-original");
    for (const bad of [dh(100), dw(1), "missing"])
      await assert.rejects(f.accountFacts(f.source.domain.communityId, bad, "learner"));
    await assert.rejects(f.accountFacts(dh(99), "actor", "learner"));
    assert.equal(f.db.count("host_fixture_acceptance"), 0);
  } finally { f.close(); }
});
test("alias change and owner epoch/assignment rotation veto the ACTUAL accepting SQL batch", async () => {
  const f = hostSimulation();
  try {
    for (const [id, mutate] of [
      ["alias", () => f.change("dance_host_accounts", "actor", body => { body.knownAliases = ["actor", "alias"]; })],
      ["owner", () => f.change("dance_host_context", null, body => { body.ownerEpoch++; body.owner.assignmentId = "assignment-next"; })],
    ] as const) {
      const facts = await f.accountFacts(f.source.domain.communityId, "actor", "learner");
      f.db.beforeBatch = mutate;
      await assert.rejects(f.store.atomic([facts.fence], [f.db.asD1().prepare("INSERT INTO host_fixture_acceptance VALUES(?)").bind(id)]));
      assert.equal(f.db.count("host_fixture_acceptance"), 0);
    }
  } finally { f.close(); }
});
test("new recorded authorization does not replace selected original; original mutation/removal fails closed", async () => {
  const f = hostSimulation();
  try {
    const old = f.originals.get("actor")!;
    const signIn = { learner: getAddress(dw(1)), nonce: dh(999) as Hex, issuedAt: BigInt(Math.floor(Date.now()/1000)-9) };
    const message = signInMessageV4({ origin: f.config.app.origin, communityId: f.source.domain.communityId,
      chainId: 6343, contract: f.source.pin.v4, publicationPolicy: dh(250) as Hex }, signIn);
    f.db.sqlite.prepare(`INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,
      policy_hash,policy_version,issued_at,state,tx_hash,created_at,updated_at)
      SELECT ?,account_id,subject,?,?,signature,policy_hash,policy_version,?,state,tx_hash,created_at,updated_at
      FROM learning_authorizations WHERE authorization_id=?`).run(hashMessage(message),
        JSON.stringify({ learner: signIn.learner, nonce: signIn.nonce, issuedAt: String(signIn.issuedAt) }), message, Number(signIn.issuedAt), old);
    assert.equal((await f.accountFacts(f.source.domain.communityId, "actor", "learner")).actor.authorizationId, old);
    f.db.sqlite.prepare("UPDATE learning_authorizations SET message=message||'changed' WHERE authorization_id=?").run(old);
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"), /authorization_invalid/);
    f.db.sqlite.prepare("DELETE FROM learning_authorizations WHERE authorization_id=?").run(old);
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"), /authorization_missing/);
  } finally { f.close(); }
});
test("wrong binding, malformed aliases and unrecorded original cannot supply authority", async () => {
  const f = hostSimulation();
  try {
    f.change("dance_host_accounts", "actor", body => { body.knownAliases = ["actor", "unknown"]; });
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"));
    f.change("dance_host_accounts", "actor", body => { body.knownAliases = ["actor", "actor"]; });
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"));
    f.change("dance_host_accounts", "actor", body => { body.knownAliases = ["actor"]; body.groupEpoch = "1"; });
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"));
    f.change("dance_host_accounts", "actor", body => { body.groupEpoch = 1; });
    f.db.sqlite.prepare("UPDATE learning_authorizations SET state='pending' WHERE authorization_id=?").run(f.originals.get("actor")!);
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"), /authorization_missing/);
    f.db.sqlite.prepare("UPDATE learning_authorizations SET state='recorded' WHERE authorization_id=?").run(f.originals.get("actor")!);
    f.db.sqlite.prepare("UPDATE credential_bindings SET account_id='alias' WHERE binding_id='binding-actor'").run();
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"), /binding/);
  } finally { f.close(); }
});
test("head transition, withdrawal, stale source or media epoch refuses and retains original rows", async () => {
  const f = hostSimulation();
  try {
    const facts = await f.accountFacts(f.source.domain.communityId, "actor", "learner");
    f.db.beforeBatch = () => { f.db.sqlite.prepare("UPDATE learning_authority_heads SET permission_revision=permission_revision+1 WHERE account_id='actor'").run(); };
    await assert.rejects(f.store.assert([facts.fence]));
    f.db.sqlite.prepare("INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at) VALUES('actor',?,?)").run(Date.now(), Date.now());
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"));
    f.change("dance_host_context", null, body => { body.sourceHash = dh(999); });
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"));
    f.change("dance_host_context", null, body => { body.sourceHash = f.source.sourceHash; body.mediaEpoch = 1; });
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"));
    assert.equal(f.db.count("learning_authorizations"), 4);
  } finally { f.close(); }
});
test("wallet case normalizes but account case and account-only owner tuple cannot borrow authority; future selected original is held", async () => {
  const f = hostSimulation();
  try {
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "Actor", "learner"));
    const ownerWallet = dw(0xabcdef);
    f.db.sqlite.prepare("UPDATE credential_bindings SET subject=? WHERE binding_id='binding-owner'").run(ownerWallet);
    f.change("dance_host_context", null, body => { body.owner.wallet = "0x" + ownerWallet.slice(2).toUpperCase(); });
    const facts = await f.accountFacts(f.source.domain.communityId, "actor", "learner");
    assert.equal(facts.owner.accountId, "owner"); assert.equal(facts.owner.wallet, ownerWallet);
    f.change("dance_host_context", null, body => { body.owner.accountId = "actor"; });
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"), /binding/);
    f.change("dance_host_context", null, body => { body.owner.accountId = "owner"; });
    const signIn = { learner: getAddress(dw(1)), nonce: dh(997) as Hex, issuedAt: BigInt(Math.floor(Date.now()/1000)+3600) };
    const message = signInMessageV4({ origin: f.config.app.origin, chainId: 6343, communityId: f.source.domain.communityId,
      contract: f.source.pin.v4, publicationPolicy: dh(250) as Hex }, signIn);
    const id = hashMessage(message), original = f.originals.get("actor")!;
    f.db.sqlite.prepare(`INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,
      policy_hash,policy_version,issued_at,state,tx_hash,created_at,updated_at)
      SELECT ?,account_id,subject,?,?,signature,policy_hash,policy_version,?,state,tx_hash,created_at,updated_at
      FROM learning_authorizations WHERE authorization_id=?`).run(id,
        JSON.stringify({ learner: signIn.learner, nonce: signIn.nonce, issuedAt: String(signIn.issuedAt) }), message, Number(signIn.issuedAt), original);
    f.change("dance_host_accounts", "actor", body => { body.authorizationId = id; });
    await assert.rejects(f.accountFacts(f.source.domain.communityId, "actor", "learner"));
    assert.equal(f.db.sqlite.prepare("SELECT state FROM learning_authorizations WHERE authorization_id=?").get(original)!.state, "recorded");
  } finally { f.close(); }
});

test("packed predicates retain positional/null/string/comment semantics and reject every false conjunct atomically", async () => {
  const f = hostSimulation();
  try {
    const literal = "x'); DROP TABLE community_accounts; -- ?";
    const packed = joinDanceFences({
      sql: "?1 IS ?1 AND ? AND '?'='?' /* ?99 */ AND 'it''s ?'='it''s ?' -- ?tail\n",
      values: [42, 1],
    }, { sql: "? IS NULL AND ?=?", values: [null, literal, literal] });
    assert.equal(packed.values.length, 1);
    // The outer producer may wrap a compiled fence without its private join metadata.
    const wrapped = { sql: "(" + packed.sql + ") AND ?=?", values: [...packed.values, "same", "same"] };
    await f.store.assert([joinDanceFences(wrapped)]);
    await assert.rejects(f.store.atomic([joinDanceFences(wrapped, { sql: "?=1", values: [0] })],
      [f.db.asD1().prepare("INSERT INTO host_fixture_acceptance VALUES('must-rollback')")]));
    assert.equal(f.db.count("host_fixture_acceptance"), 0); assert.equal(f.db.count("community_accounts"), 4);
    assert.throws(() => joinDanceFences({ sql: "?", values: [Number.NaN] }));
    assert.throws(() => joinDanceFences({ sql: "?", values: new Array<number>(1) }));
    assert.throws(() => joinDanceFences({ sql: "?2", values: [1] }));
  } finally { f.close(); }
});

test("genuine D1 100/101 canary and ordinary/max-alias combined actor+learner+owner admission remain within the engine limit", async () => {
  for (const maximum of [false, true]) {
    const f = hostSimulation();
    let engine: Awaited<ReturnType<typeof genuineD1>> | undefined;
    try {
      if (maximum) {
        const ids = Array.from({ length: 127 }, (_, i) => "known_alias_" + String(i).padStart(3, "0"));
        for (const [i, id] of ids.entries())
          f.db.sqlite.prepare("INSERT INTO community_accounts VALUES(?,?,?)").run(id, dh(5000 + i), Date.now());
        for (const id of ["actor", "learner"])
          f.change("dance_host_accounts", id, body => { body.knownAliases = [id, ...ids].sort(); });
      }
      engine = await genuineD1(f.db);
      const accounts = createDanceAccountFacts({ db: engine.db, source: f.source, config: f.config });
      const facts = await accounts(f.source.domain.communityId, "actor", "learner"), store = new DanceStore(engine.db);
      assert.equal(facts.actor.knownAliases.length, maximum ? 128 : 1);
      assert.equal(facts.learner.knownAliases.length, maximum ? 128 : 1);
      assert.equal(facts.fence.values.length, 1);
      const wrapped = { sql: "(" + facts.fence.sql + ") AND ?=?", values: [...facts.fence.values, 7, 7] };
      const joinedWrapped = joinDanceFences(wrapped);
      try {
        await store.atomic([joinedWrapped], [engine.db.prepare("INSERT INTO host_fixture_acceptance VALUES('accepted')").bind()]);
      } catch (error) {
        // Bounded, controlled hostSimulation fixture only. Never log bound
        // account/signature/JSON values, or add a production SQL logger.
        const guardSql = "INSERT INTO dance_transaction_guards SELECT ?,CASE WHEN (" + joinedWrapped.sql + ") THEN 1 ELSE 0 END";
        const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
        console.error("DANCE_ACCOUNT_D1_FIXTURE_BOUNDARY " + JSON.stringify({
          version: 1, fixture: "hostSimulation", maximum,
          actorAliases: facts.actor.knownAliases.length, learnerAliases: facts.learner.knownAliases.length,
          originalFenceSqlBytes: bytes(facts.fence.sql), wrapperSqlBytes: bytes(wrapped.sql),
          joinedFenceSqlBytes: bytes(joinedWrapped.sql), guardSqlBytes: bytes(guardSql),
          originalBindCount: facts.fence.values.length, wrapperBindCount: wrapped.values.length,
          joinedBindCount: joinedWrapped.values.length, guardBindCount: 1 + joinedWrapped.values.length,
          joinedValueTypes: joinedWrapped.values.map(value => value === null ? "null" : typeof value),
          encodedBindingsBytes: bytes(JSON.stringify(joinedWrapped.values)), guardSqlTemplate: guardSql,
        }));
        throw error;
      }
      assert.deepEqual(JSON.parse(String(joinedWrapped.values[0])), [...facts.fence.values, 7, 7]);
      const detached = structuredClone(facts.fence);
      const unequal = { sql: "(" + detached.sql + ") AND ?=?", values: [...detached.values, 7, 8] };
      await assert.rejects(store.atomic([joinDanceFences(unequal)],
        [engine.db.prepare("INSERT INTO host_fixture_acceptance VALUES('refused-wrapper')").bind()]), /dance_fence_changed|CHECK constraint failed: valid/);
      const literal = "fixture '?' and 'quoted' -- ?";
      const typed = { sql: "(" + detached.sql + ") AND ? IS NULL AND ?=? AND typeof(?)='integer'",
        values: [...detached.values, null, literal, literal, 7] };
      await store.assert([joinDanceFences(typed)]);
      const row = await engine.db.prepare("SELECT revision,body_json FROM dance_host_accounts WHERE community_id=? AND account_id='learner'")
        .bind(f.source.domain.communityId).first<{ revision: number; body_json: string }>();
      const changed = JSON.parse(row!.body_json); changed.active = false;
      await engine.db.prepare("UPDATE dance_host_accounts SET revision=revision+1,body_json=? WHERE community_id=? AND account_id='learner'")
        .bind(JSON.stringify(changed), f.source.domain.communityId).run();
      await assert.rejects(store.atomic([facts.fence], [engine.db.prepare("INSERT INTO host_fixture_acceptance VALUES('refused')").bind()]));
      assert.deepEqual((await engine.db.prepare("SELECT id FROM host_fixture_acceptance ORDER BY id").all<{ id: string }>()).results,
        [{ id: "accepted" }]);
      assert.ok(engine.binds.length > 0 && engine.binds.every(n => n <= 100));
    } finally { await engine?.dispose(); f.close(); }
  }
});

test("genuine D1 depth-100 canary, balanced nested guards and detached authority wrappers preserve every atomic predicate", async () => {
  const f = hostSimulation();
  let engine: Awaited<ReturnType<typeof genuineD1>> | undefined;
  try {
    engine = await genuineD1(f.db);
    const db = engine.db, store = new DanceStore(db);
    // Independent depth canary: zero bound values, actual native D1, no clamp.
    // These distinct live-row predicates cannot fail because of the bind limit.
    const flat = Array.from({ length: 513 }, (_, i) =>
      "(EXISTS(SELECT 1 FROM community_accounts WHERE account_id='actor' AND " + i + "=" + i + "))").join(" AND ");
    await assert.rejects(async () => db.prepare("SELECT 1 WHERE " + flat).bind().all(), /expression tree is too large|maximum depth/i);
    // Stress conjunction association without increasing the supported alias or
    // page limits. Odd leaf count also exercises an unpaired final branch.
    const leaves = Array.from({ length: 513 }, (_, i) => ({
      sql: "EXISTS(SELECT 1 FROM community_accounts WHERE account_id=? AND ?=" + i + ")",
      values: ["actor", i],
    }));
    const combined = joinDanceFences(joinDanceFences(...leaves.slice(0, 200)), joinDanceFences(...leaves.slice(200)));
    assert.equal(combined.values.length, 1);
    assert.deepEqual(JSON.parse(String(combined.values[0])), leaves.flatMap(leaf => leaf.values));
    // The actual authority producer clones local facts, losing private join
    // metadata, then adds projection/grant guards. Preserve that SQL nesting.
    const detached = structuredClone(combined);
    const wrapped = { sql: "(" + detached.sql + ") AND EXISTS(SELECT 1 FROM community_accounts WHERE account_id=?)" +
      " AND EXISTS(SELECT 1 FROM community_accounts WHERE account_id=?)", values: [...detached.values, "owner", "learner"] };
    const admitted = joinDanceFences(wrapped, { sql: "? IS NULL", values: [null] });
    await store.atomic([admitted], [db.prepare("INSERT INTO host_fixture_acceptance VALUES('balanced-accepted')").bind()]);
    // Reject first, middle and unmatched final positions in the SAME
    // guard/mutation batch. No leaf may be omitted during grouping or rejoin.
    for (const index of [0, 256, 512]) {
      const changed = leaves.map((leaf, i) => i === index ? { ...leaf, values: ["actor", -1] } : leaf);
      const fence = joinDanceFences(joinDanceFences(...changed.slice(0, 200)), joinDanceFences(...changed.slice(200)));
      await assert.rejects(store.atomic([fence], [db.prepare("INSERT INTO host_fixture_acceptance VALUES(?)").bind("refused-" + index)]));
    }
    const missingGrant = { ...wrapped, values: [...detached.values, "owner", "missing"] };
    await assert.rejects(store.atomic([joinDanceFences(missingGrant)],
      [db.prepare("INSERT INTO host_fixture_acceptance VALUES('refused-wrapper')").bind()]));
    assert.deepEqual((await db.prepare("SELECT id FROM host_fixture_acceptance ORDER BY id").all<{ id: string }>()).results,
      [{ id: "balanced-accepted" }]);
    assert.ok(engine.binds.length > 0 && engine.binds.every(n => n <= 100));
  } finally { await engine?.dispose(); f.close(); }
});

