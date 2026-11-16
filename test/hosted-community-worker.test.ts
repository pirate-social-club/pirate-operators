import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, parseTransaction } from "viem";
import { allOperations, assertHostedSchema } from "../packages/community/hosted-enrollment-store.ts";
import { createHostedEnrollmentService } from "../services/hosted-community-enrollment.ts";
import { hostedFixture } from "./fixtures/hosted-community-enrollment.ts";

// Integration failure matrix is retained in the admitted composition packet.
// Existing business tests remain intact; these cover the real packaging boundary.
test("packaged hosted prepare reaches the real factory and installed Alchemy D1 ledger", async () => {
  const f = await hostedFixture({}, { packaged: true });
  try {
    assert(f.worker);
    const i = await f.invite(), prepared = await f.prepare(i);
    assert.equal(prepared.e.inviteId, i.id);
    assert.equal(prepared.e.plan.profile.installationId, i.profile.installationId);
    assert.equal(f.state.sendCount, 0);
    const rows = await f.db.prepare("SELECT * FROM __alchemy_migrations ORDER BY id").all();
    assert.equal(rows.results.length, 1);
    assert.equal(rows.results[0]!.name, "0001_hosted_enrollment.sql");
    assert.equal(rows.results[0]!.hash, "6f217ee3545c6f6c96a4ffc8e633246e43ff7b0c85e802341a653e9f93f403ce");
    const before = await f.db.prepare("SELECT * FROM hosted_preparations").all();
    await f.worker.repeatMigrations();
    assert.deepEqual((await f.db.prepare("SELECT * FROM hosted_preparations").all()).results, before.results);
    assert.deepEqual((await f.db.prepare("SELECT * FROM __alchemy_migrations ORDER BY id").all()).results, rows.results);
    await f.worker.evidence("early-real-route-migrator", { enrollmentId: prepared.e.id, ledger: rows.results, originalPreserved: true });
  } finally { await f.close(); }
});

test("packaged registration and initial topup retain exact originals through key retirement and restart", async () => {
  const f = await hostedFixture({}, { packaged: true });
  try {
    assert(f.worker);
    const p = await f.prepare(await f.invite());
    f.state.dropSend = 1;
    assert.equal((await f.post("/redeem", p.auth)).status, 200);
    const original = (await allOperations(f.db, p.e.id))[0]!;
    assert(original.raw && original.tx_hash);
    assert.equal(keccak256(original.raw), original.tx_hash);
    const tx = parseTransaction(original.raw);
    assert.equal(tx.to?.toLowerCase(), f.directory);
    assert.equal(tx.nonce, original.nonce);
    assert.equal(tx.gas, BigInt(f.policy.registrationGas));
    assert.equal(tx.value ?? 0n, 0n);
    assert.equal(tx.data, p.e.plan.data);
    await f.mine();
    await f.worker.restart({ registrar: null, funder: null });
    const sends = f.state.sendCount;
    assert.equal((await f.post("/status", p.auth)).status, 200);
    const settled = (await allOperations(f.db, p.e.id))[0]!;
    assert.equal(settled.state, "consumed");
    assert.equal(settled.raw, original.raw); assert.equal(settled.tx_hash, original.tx_hash); assert.equal(settled.nonce, original.nonce);
    assert.equal(f.state.sendCount, sends);
    await f.worker.restart();
    const recipientProofs = await Promise.all([f.accounts.controller, f.accounts.publisher].map(async account => ({ recipient: account.address.toLowerCase(), signature: await account.signTypedData((await import("../packages/community/hosted-enrollment.ts")).enrollmentTypedData(p.e)) })));
    assert.equal((await f.post("/initial-topup", { ...p.auth, recipientProofs })).status, 200);
    await f.mine(); await f.worker.restart({ registrar: null, funder: null });
    assert.equal((await f.post("/status", p.auth)).status, 200);
    const ops = await allOperations(f.db, p.e.id);
    assert.equal(ops.length, 3); assert(ops.every(op => op.state === "consumed"));
    const budgets = (await f.db.prepare("SELECT * FROM spending_budgets ORDER BY scope,period,asset").all()).results;
    await f.worker.repeatMigrations();
    assert.deepEqual(await allOperations(f.db, p.e.id), ops);
    assert.deepEqual((await f.db.prepare("SELECT * FROM spending_budgets ORDER BY scope,period,asset").all()).results, budgets);
    const privateText = JSON.stringify((await f.post("/status", p.auth)).body);
    for (const op of ops) assert(!privateText.includes(op.raw!));
    await f.worker.evidence("retired-keys-original-recovery", { operations: ops.map(op => ({ kind: op.kind, state: op.state, hash: op.tx_hash, nonce: op.nonce })), sends: f.state.sendCount });
  } finally { await f.close(); }
});

test("packaged effect keys are lazy and missing or wrong roles cannot replace reserved operations", async () => {
  const f = await hostedFixture({}, { packaged: true });
  try {
    assert(f.worker);
    await f.worker.restart({ registrar: null, funder: null });
    const p = await f.prepare(await f.invite());
    assert.equal((await f.post("/status", p.auth)).status, 200);
    assert.equal((await f.post("/redeem", p.auth)).status, 503);
    const before = await allOperations(f.db, p.e.id);
    assert.equal(before.length, 1); assert.equal(before[0]!.raw, null);
    assert.equal(f.state.sendCount, 0);
    await f.worker.restart({ registrar: `0x${"01".repeat(32)}`, funder: null });
    assert.equal((await f.post("/redeem", p.auth)).status, 503);
    assert.deepEqual(await allOperations(f.db, p.e.id), before);
    assert.equal(f.state.sendCount, 0);
    await f.worker.restart();
    assert.equal((await f.post("/redeem", p.auth)).status, 200);
    assert.equal((await allOperations(f.db, p.e.id))[0]!.nonce, before[0]!.nonce);
    await f.worker.evidence("lazy-role-refusals", { preservedNonce: before[0]!.nonce, sends: f.state.sendCount });
  } finally { await f.close(); }
});

test("packaged schema validates the complete ledger and exact DDL without repair or business reset", async () => {
  const f = await hostedFixture({}, { packaged: true });
  try {
    assert(f.worker);
    const i = await f.invite(), saved = await f.db.prepare("SELECT * FROM __alchemy_migrations").first<{id:number;hash:string;created_at:number|null;name:string;applied_at:string}>();
    assert(saved);
    const restore = async () => { await f.db.prepare("DELETE FROM __alchemy_migrations").run(); await f.db.prepare("INSERT INTO __alchemy_migrations(id,hash,created_at,name,applied_at) VALUES(?,?,?,?,?)").bind(saved.id,saved.hash,saved.created_at,saved.name,saved.applied_at).run(); };
    for (const sql of ["DELETE FROM __alchemy_migrations", "UPDATE __alchemy_migrations SET hash='wrong'", "UPDATE __alchemy_migrations SET name='foreign.sql'", "INSERT INTO __alchemy_migrations(hash,name) SELECT hash,name FROM __alchemy_migrations", "INSERT INTO __alchemy_migrations(hash,name) VALUES('foreign','0002_foreign.sql')"]) {
      await f.db.prepare(sql).run();
      assert.equal((await f.post("/prepare", i.body)).status, 503);
      assert.equal(f.state.sendCount, 0); await restore();
    }
    for (const sql of ["CREATE TABLE __alchemy_foreign(value TEXT)", "CREATE INDEX foreign_idx ON hosted_invites(id)", "CREATE TRIGGER foreign_trig AFTER INSERT ON hosted_invites BEGIN SELECT 1; END"]) {
      const snapshot = await f.db.prepare("SELECT name,type FROM sqlite_master").all();
      await f.db.prepare(sql).run(); assert.equal((await f.post("/prepare", i.body)).status, 503);
      const created = (await f.db.prepare("SELECT name,type FROM sqlite_master").all()).results.find(row => !snapshot.results.some(old => old.name === row.name));
      assert(created); assert(["table","index","trigger"].includes(String(created.type)));
      await f.db.prepare(`DROP ${created.type} ${created.name}`).run();
    }
    await f.db.prepare("ALTER TABLE __alchemy_migrations ADD COLUMN foreign_stamp TEXT").run();
    assert.equal((await f.post("/prepare", i.body)).status, 503);
    await f.worker.evidence("schema-ledger-refusals", { cases: 9, sends: f.state.sendCount });
  } finally { await f.close(); }
});

test("private hosted schema context is captured before awaits while raw-v1 stays unchanged", async () => {
  const f = await hostedFixture({}, { packaged: true });
  try {
    assert(f.worker);
    await assert.rejects(assertHostedSchema(f.db), /hosted_schema_mismatch/);
    const context = { ...f.worker.context, migrations: f.worker.context.migrations.map(row => ({ ...row })) }, handler = createHostedEnrollmentService({ ...f.runtime, schemaContext: context });
    context.migrations[0]!.hash = "00".repeat(32);
    const i = await f.invite();
    assert.equal((await f.post("/prepare", i.body, handler)).status, 200);
    await assert.rejects(assertHostedSchema(f.db, context), /hosted_schema_mismatch/);
    await f.worker.evidence("owned-context", { capturedBeforeAwait: true, rawV1DidNotIgnoreMetadata: true });
  } finally { await f.close(); }
});

test("packaged Worker retains strict request and trusted transport boundaries", async () => {
  const f = await hostedFixture({}, { packaged: true });
  try {
    assert(f.worker);
    const i = await f.invite();
    for (const [path, init, expected] of [
      ["/prepare", { method: "GET" }, 405], ["/prepare", { method: "POST", headers: { cookie: "ambient=1" }, body: JSON.stringify(i.body) }, 403],
      ["/admin", { method: "POST", body: "{}" }, 404], ["/health", { method: "GET" }, 404],
      ["/prepare", { method: "POST", headers: { host: "wrong.example" }, body: JSON.stringify(i.body) }, 403],
      ["/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...i.body, rpcUrl: "https://attacker.invalid", schemaContext: f.worker.context }) }, 400],
    ] as const) {
      try { assert.equal((await f.worker.request(path, init)).status, expected, `boundary:${init.method}:${path}`); }
      catch (error) { throw new Error(`hosted_boundary:${init.method}:${path}:${"headers" in init && "host" in init.headers ? "wrong-host" : "ordinary"}`, { cause: error }); }
    }
    f.state.invalidPin = true; assert.equal((await f.post("/prepare", i.body)).status, 503); f.state.invalidPin = false;
    assert.equal(f.state.sendCount, 0);
    await f.worker.evidence("request-boundaries", { sends: f.state.sendCount });
  } finally { await f.close(); }
});

test("hosted package collects only dedicated D1 and Worker with optional redacted role keys", async () => {
  const f = await hostedFixture({}, { packaged: true });
  try {
    assert(f.worker);
    const noKeys = await f.worker.collectProfile(false), withKeys = await f.worker.collectProfile(true);
    assert.deepEqual(noKeys.resources.map(row => row.type).sort(), ["Cloudflare.D1Database", "Cloudflare.Worker"]);
    assert.deepEqual(noKeys.resources.flatMap(row => row.secretNames), []);
    assert.deepEqual(withKeys.resources.flatMap(row => row.secretNames).sort(), ["HOSTED_FUNDER_PRIVATE_KEY", "HOSTED_REGISTRAR_PRIVATE_KEY"]);
    assert(noKeys.resources.every(row => row.crons.length === 0 && !row.assets));
    assert.equal(noKeys.stack, "pirate-hosted-local-fixture");
    assert.equal(noKeys.resources.find(row => row.type === "Cloudflare.D1Database")!.migrations, "./migrations");
    assert.equal(noKeys.resources.find(row => row.type === "Cloudflare.Worker")!.date, "2026-08-06");
    for (const selection of ["missing", "managed-web2", "operator-signing-only", "unknown", "wrong-plan", "wrong-digest"]) {
      const refused = await f.worker.collectProfile(false, selection);
      assert.equal(refused.exit, 1, selection); assert.equal(refused.stateCreated, false, selection);
    }
    await f.worker.evidence("actual-sdk-hosted-profile", { noKeys, withKeys });
  } finally { await f.close(); }
});

test("packaged configuration and private context cannot be selected or replaced by HTTP or changed bindings", async () => {
  const f = await hostedFixture({}, { packaged: true });
  try {
    assert(f.worker);
    const i = await f.invite();
    for (const fault of ["profile", "configuration-pin", "missing-context", "ledger-context", "rpc-origin"]) {
      await f.worker.configurationFault(fault, async () => {
        assert.equal((await f.post("/prepare", i.body)).status, 503, fault);
        assert.equal((await f.db.prepare("SELECT count(*) AS n FROM hosted_preparations").first<{n:number}>())!.n, 0);
      });
    }
    f.state.redirectPin = true;
    assert.equal((await f.post("/prepare", i.body)).status, 503);
    f.state.redirectPin = false;
    assert.equal((await f.post("/prepare", i.body)).status, 200);
    assert.equal(f.state.sendCount, 0);
    await f.worker.evidence("trusted-config-refusals", { sends: f.state.sendCount, redirectsFollowed: 0 });
  } finally { await f.close(); }
});

test("D1 rejects protected metadata mutation while packaged originals and counters remain intact", async () => {
  const f = await hostedFixture({}, { packaged: true });
  try {
    assert(f.worker); await f.worker.restart({ registrar: null, funder: null });
    const i = await f.invite(), p = await f.prepare(i);
    assert.equal((await f.post("/redeem", p.auth)).status, 503);
    const original = await allOperations(f.db, p.e.id),
      schema = (await f.db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all()).results,
      budgets = (await f.db.prepare("SELECT * FROM spending_budgets ORDER BY scope,period,asset").all()).results;
    assert.equal(original.length, 1); assert.equal(original[0]!.raw, null); assert(budgets.length > 0);
    assert(schema.some(row => row.name === "_cf_METADATA"));
    await assert.rejects(f.db.prepare("ALTER TABLE _cf_METADATA ADD COLUMN foreign_value TEXT").run(), /not authorized: SQLITE_AUTH/);
    assert.deepEqual((await f.db.prepare("SELECT name,type,sql FROM sqlite_master ORDER BY name").all()).results, schema);
    assert.deepEqual(await allOperations(f.db, p.e.id), original);
    assert.deepEqual((await f.db.prepare("SELECT * FROM spending_budgets ORDER BY scope,period,asset").all()).results, budgets);
    assert.equal((await f.post("/status", p.auth)).status, 200);
    assert.equal((await f.prepare(i)).e.id, p.e.id);
    assert.deepEqual(await allOperations(f.db, p.e.id), original);
    assert.equal(f.state.sendCount, 0);
    await f.worker.evidence("internal-metadata-refusal", { unchangedSchema: true, originalId: original[0]!.id, nonce: original[0]!.nonce, budgetRows: budgets.length, sends: f.state.sendCount });
  } finally { await f.close(); }
});

test("public hosted signer ports refuse known local fixture keys before any signature or transport", async () => {
  const f = await hostedFixture();
  try {
    const { configuredHostedRuntime } = await import("../services/hosted-community-runtime.ts"),
      { policyDocument } = await import("../packages/community/hosted-enrollment.ts"),
      { canonical, hashText } = await import("../packages/community/common.ts"),
      { privateKeyToAccount } = await import("viem/accounts");
    const key = `0x${"a".padStart(64, "0")}` as const, account = privateKeyToAccount(key);
    const policy = { ...policyDocument(f.policy), registrar: account.address.toLowerCase(), funder: account.address.toLowerCase(), deployment: { ...policyDocument(f.policy).deployment, chainId: 6343 } };
    const configuration = canonical({ schema: "pirate.hosted-community-runtime/1", policy, rpcUrl: "https://never-contacted.invalid/", configurationGateway: "https://never-contacted.invalid/ipfs/",
      schemaContext: { schema: "pirate.hosted-schema-alchemy/1", table: "__alchemy_migrations", migrations: [{ name: "0001_hosted_enrollment.sql", hash: "6f217ee3545c6f6c96a4ffc8e633246e43ff7b0c85e802341a653e9f93f403ce" }] } });
    for (const selected of [key, "0x" + key.slice(2).toUpperCase()]) {
      const r = configuredHostedRuntime({ DB: f.db, HOSTED_COMMUNITY_PROFILE: "hosted-enrollment", HOSTED_COMMUNITY_CONFIGURATION_JSON: configuration,
        HOSTED_COMMUNITY_CONFIGURATION_SHA256: hashText(configuration), HOSTED_REGISTRAR_PRIVATE_KEY: selected, HOSTED_FUNDER_PRIVATE_KEY: selected });
      const transaction = { type: "eip1559" as const, chainId: 6343, to: f.directory, data: "0x" as const, value: 0n, nonce: 0, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
      await assert.rejects(r.registrar.signTransaction(transaction), /public_fixture_key_forbidden/);
      await assert.rejects(r.funder.signTransaction(transaction), /public_fixture_key_forbidden/);
    }
    assert.equal(f.state.sendCount, 0);
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM hosted_operations").first<{n:number}>())!.n, 0);
  } finally { await f.close(); }
});

test("fresh hosted package retains its explicit owned-lock dependency selection through its writer", async () => {
  const f = await hostedFixture({}, { packaged: true });
  try {
    assert(f.worker);
    const { writeHostedCommunityPackage } = await import("../harness/managed-package.ts");
    const { realpath, readFile, mkdtemp } = await import("node:fs/promises"), { join, resolve } = await import("node:path"), { tmpdir } = await import("node:os"), { createHash } = await import("node:crypto");
    const selected = f.worker.pkg.dependencyInput;
    assert.equal(selected.provenance.kind, "owned-committed-lock");
    assert.equal(await realpath(selected.modules), await realpath(resolve("apps/community-wizard/node_modules")));
    assert.equal(selected.provenance.lockSha256, createHash("sha256").update(await readFile("apps/community-wizard/package-lock.json")).digest("hex"));
    const fresh = await mkdtemp(join(tmpdir(), "hosted-wrong-dependencies-"));
    await assert.rejects(writeHostedCommunityPackage(fresh, f.worker.pkg, { ...selected, modules: resolve("node_modules") }), /fresh_dependency_selection_changed/);
    await assert.rejects(readFile(join(fresh, "deployment/managed-web2-package.json")), { code: "ENOENT" });
    assert.equal((await f.post("/status", (await f.prepare(await f.invite())).auth)).status, 200);
    await f.worker.evidence("owned-lock-package-selection", { provenance: selected.provenance, wrongSelectionRefused: true });
  } finally { await f.close(); }
});
