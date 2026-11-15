import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { nativeProducerFixture } from "./application-native-producer-fixture.ts";
import {
  initializeWeb2Schema,
  type Web2SchemaPlan,
} from "../deploy/linux/web2-initialization.ts";

const overlays = [
  "packages/community/catalog-phase-rebuild.sql",
  "packages/community/catalog-obligation.sql",
  "packages/community/native-business.sql",
];
async function sourcePlan(): Promise<Web2SchemaPlan> {
  const { stdout } = await promisify(execFile)(
    "/usr/bin/python3",
    [
      "-B",
      "deploy/linux/split-migrations.py",
      process.cwd(),
      JSON.stringify(overlays),
      "web2-first-song/1",
    ],
    { maxBuffer: 1024 ** 2 },
  );
  return { schema: "pirate.linux-web2-schema/1", overlays: JSON.parse(stdout) };
}
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
