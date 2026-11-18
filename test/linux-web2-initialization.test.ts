import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import {
  nativeMigrationNames,
  nativeProducerFixture,
} from "./application-native-producer-fixture.ts";
import { communityMigrations } from "../harness/package-migrations.ts";
import {
  initializeWeb2Schema,
  selectWeb2PublicationConsent,
  type Web2SchemaPlan,
} from "../deploy/linux/web2-initialization.ts";

const overlays = [
  "packages/community/catalog-phase-rebuild.sql",
  "packages/community/catalog-obligation.sql",
  "packages/community/native-business.sql",
];
async function splitSql(
  names: string[],
  root: string,
  profile?: "web2-first-song/1",
): Promise<Web2SchemaPlan["overlays"]> {
  const { stdout } = await promisify(execFile)(
    "/usr/bin/python3",
    [
      "-B",
      "deploy/linux/split-migrations.py",
      root,
      JSON.stringify(names),
      ...(profile ? [profile] : []),
    ],
    { maxBuffer: 1024 ** 2 },
  );
  return JSON.parse(stdout);
}
async function sourcePlan(): Promise<Web2SchemaPlan> {
  return {
    schema: "pirate.linux-web2-schema/1",
    overlays: await splitSql(overlays, process.cwd(), "web2-first-song/1"),
  };
}

async function installSelectedPrivateDance(db: D1Database) {
  const root = "apps/community-wizard/infra/migrations";
  const selected = communityMigrations(await readdir(root), {
    rewards: true,
    ownerPublishing: true,
    v4: true,
    rewardClosure: true,
    media: true,
    dance: true,
    privateDance: true,
  });
  // nativeProducerFixture has already applied this actual numbered prefix.
  // The artifact's numbered phase applies 0022 before all unnumbered overlays.
  assert.deepEqual(selected, [...nativeMigrationNames, "0022_dance_private_practice.sql"]);
  const [migration] = await splitSql(selected.slice(nativeMigrationNames.length), root);
  assert.equal(migration?.name, "0022_dance_private_practice.sql");
  assert.equal(migration.statements.join(""), migration.sql);
  await db.batch(migration.statements.filter(sql => sql.trim()).map(sql => db.prepare(sql)));
}
const schemaRows = async (db: D1Database) => (
  await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name").all()
).results;

// Credible failures: lost initialization acknowledgement, changed source,
// unknown executable schema and partial DDL. Exercise real transactional D1.
test(
  "fresh Web2 schema applies pinned overlays atomically and retains account data through exact restart",
  { timeout: 30000 },
  async (t) => {
    const f = await nativeProducerFixture(false);
    t.after(f.dispose);
    await f.login();
    const accounts = (
      await f.db
        .prepare("SELECT * FROM community_accounts ORDER BY account_id")
        .all()
    ).results;
    assert.equal(accounts.length, 1);
    const plan = await sourcePlan(),
      release = "ab".repeat(32);
    const first = await initializeWeb2Schema(f.db, plan, release);
    assert.equal(first.alreadyInitialized, false);
    const schema = (await f.db
      .prepare("SELECT schema_json FROM _pirate_web2_schema")
      .first())!;
    const restart = await initializeWeb2Schema(f.db, plan, release);
    assert.equal(restart.alreadyInitialized, true);
    assert.equal(restart.manifestSha256, first.manifestSha256);
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT * FROM community_accounts ORDER BY account_id")
          .all()
      ).results,
      accounts,
    );
    assert.deepEqual(
      await f.db.prepare("SELECT schema_json FROM _pirate_web2_schema").first(),
      schema,
    );
    const changed = structuredClone(plan);
    changed.overlays[0]!.sql += "\n";
    await assert.rejects(
      initializeWeb2Schema(f.db, changed, release),
      /web2_schema_source_changed/,
    );
    await assert.rejects(
      initializeWeb2Schema(f.db, plan, "cd".repeat(32)),
      /web2_schema_refusal/,
    );
    await f.db.prepare("CREATE TABLE unexpected_schema(id TEXT)").run();
    await assert.rejects(
      initializeWeb2Schema(f.db, plan, release),
      /web2_schema_refusal/,
    );
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT * FROM community_accounts ORDER BY account_id")
          .all()
      ).results,
      accounts,
    );
    await mkdir(".local/linux-web2-installation", { recursive: true });
    await writeFile(
      ".local/linux-web2-installation/schema-restart.json",
      JSON.stringify({
        first,
        restart,
        accountsRetained: accounts.length,
        changedSourceAndSchemaRefused: true,
      }) + "\n",
    );
  },
);

test(
  "fresh Web2 schema refuses unknown executable input without leaving a partial overlay or ledger",
  { timeout: 30000 },
  async (t) => {
    const f = await nativeProducerFixture(false);
    t.after(f.dispose);
    await f.db
      .prepare(
        "CREATE TRIGGER unexpected_input AFTER INSERT ON community_accounts BEGIN SELECT 1; END",
      )
      .run();
    const before = (
      await f.db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name",
        )
        .all()
    ).results;
    await assert.rejects(
      initializeWeb2Schema(f.db, await sourcePlan(), "ab".repeat(32)),
      /catalog_phase_schema_refusal/,
    );
    assert.deepEqual(
      (
        await f.db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name",
          )
          .all()
      ).results,
      before,
    );
  },
);


test(
  "fresh native Web2 initializes and reopens the exact 0022 private Dance schema",
  { timeout: 30000 },
  async (t) => {
    const f = await nativeProducerFixture(false);
    t.after(f.dispose);
    await installSelectedPrivateDance(f.db);
    const privateTriggers = async () => (await f.db.prepare(
      "SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger' " +
      "AND tbl_name IN ('dance_host_context','dance_host_accounts','dance_host_selections'," +
      "'dance_host_song_keys','dance_host_audio_probes','dance_source3_requests') ORDER BY name",
    ).all()).results;
    const before = await privateTriggers();
    assert.equal(before.length, 20);
    const plan = await sourcePlan();
    const release = "ab".repeat(32);
    assert.equal((await initializeWeb2Schema(f.db, plan, release)).alreadyInitialized, false);
    assert.deepEqual(await privateTriggers(), before);
    assert.ok(await f.db.prepare("SELECT name FROM sqlite_schema WHERE name='publication_catalog_obligations'").first());
    assert.ok(await f.db.prepare("SELECT name FROM sqlite_schema WHERE name='native_business_bindings'").first());
    assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.equal((await initializeWeb2Schema(f.db, plan, release)).alreadyInitialized, true);
    assert.deepEqual(await privateTriggers(), before);
  },
);

test(
  "fresh native Web2 refuses a byte-changed 0022 trigger with its exact name and owner",
  { timeout: 30000 },
  async (t) => {
    const f = await nativeProducerFixture(false);
    t.after(f.dispose);
    await installSelectedPrivateDance(f.db);
    await f.db.batch([
      f.db.prepare("DROP TRIGGER dance_source3_request_no_delete"),
      f.db.prepare("CREATE TRIGGER dance_source3_request_no_delete BEFORE DELETE ON dance_source3_requests BEGIN SELECT 1; END"),
    ]);
    const before = await schemaRows(f.db);
    await assert.rejects(initializeWeb2Schema(f.db, await sourcePlan(), "ab".repeat(32)), /catalog_phase_schema_refusal/);
    assert.deepEqual(await schemaRows(f.db), before);
  },
);


test(
  "fresh Web2 requires exactly the consent trigger pair selected by verified adjacent migrations",
  { timeout: 30000 },
  async (t) => {
    const f = await nativeProducerFixture(false);
    t.after(f.dispose);
    const root = "apps/community-wizard/infra/migrations";
    const selected = communityMigrations(await readdir(root), {
      rewards: true, ownerPublishing: true, v4: true, rewardClosure: true,
      media: true, dance: true, privateDance: true, publicationConsent: true,
    });
    const added = selected.slice(nativeMigrationNames.length);
    assert.deepEqual(selected, [...nativeMigrationNames,
      "0020_publication_consent.sql", "0021_publication_installed_selection.sql", "0022_dance_private_practice.sql"]);
    const numbered = await splitSql(added, root);
    const [consent, mount, practice] = numbered;
    assert(consent && mount && practice);
    assert.throws(() => selectWeb2PublicationConsent([consent]), /web2_publication_consent_migrations_changed/);
    assert.throws(() => selectWeb2PublicationConsent([consent, practice, mount]), /web2_publication_consent_migrations_changed/);
    assert.throws(() => selectWeb2PublicationConsent([consent, { ...mount, sha256: "00".repeat(32) }]),
      /web2_publication_consent_migrations_changed/);
    assert.equal(selectWeb2PublicationConsent([practice]), false);
    const publicationConsent = selectWeb2PublicationConsent(numbered);
    assert.equal(publicationConsent, true);
    const plan = await sourcePlan(), release = "cd".repeat(32);
    const expectRollback = async (selected: boolean) => {
      const before = await schemaRows(f.db);
      await assert.rejects(initializeWeb2Schema(f.db, plan, release, { publicationConsent: selected }),
        /catalog_phase_schema_refusal/);
      assert.deepEqual(await schemaRows(f.db), before);
    };
    await expectRollback(publicationConsent);
    for (const row of numbered)
      await f.db.batch(row.statements.filter(sql => sql.trim()).map(sql => f.db.prepare(sql)));
    const consentTriggers = async () => (await f.db.prepare(
      "SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger' AND name GLOB 'publication_v1_*' ORDER BY name",
    ).all<{ name: string; tbl_name: string; sql: string }>()).results;
    const before = await consentTriggers();
    assert.equal(before.length, 19);
    await expectRollback(false);

    const original = before.find(row => row.name === "publication_v1_archive_delete");
    assert(original);
    await f.db.prepare("DROP TRIGGER publication_v1_archive_delete").run();
    await expectRollback(publicationConsent);
    await f.db.prepare(
      "CREATE TRIGGER publication_v1_archive_delete BEFORE DELETE ON publication_v1_release_archive BEGIN SELECT 1; END",
    ).run();
    await expectRollback(publicationConsent);
    await f.db.batch([
      f.db.prepare("DROP TRIGGER publication_v1_archive_delete"),
      f.db.prepare(original.sql),
      f.db.prepare("CREATE TRIGGER publication_v1_unexpected BEFORE DELETE ON publication_v1_release_archive BEGIN SELECT 1; END"),
    ]);
    await expectRollback(publicationConsent);
    await f.db.prepare("DROP TRIGGER publication_v1_unexpected").run();

    const first = await initializeWeb2Schema(f.db, plan, release, { publicationConsent });
    assert.equal(first.alreadyInitialized, false);
    assert.deepEqual(await consentTriggers(), before);
    assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    const reopened = await initializeWeb2Schema(f.db, plan, release, { publicationConsent });
    assert.equal(reopened.alreadyInitialized, true);
    assert.equal(reopened.manifestSha256, first.manifestSha256);
    const installed = await schemaRows(f.db);
    await assert.rejects(initializeWeb2Schema(f.db, plan, release), /web2_schema_refusal/);
    assert.deepEqual(await schemaRows(f.db), installed);
  },
);
