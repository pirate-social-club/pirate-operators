// Test-only reuse of the pinned Alchemy parser/core and D1 transport boundary
// qualified by learning-authority-d1-fixture.ts. No copied migration SQL,
// provider credentials or live gateway; the caller supplies local workerd D1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";

const wizard = createRequire(
  new URL("../apps/community-wizard/package.json", import.meta.url),
);
const cfEntry = wizard.resolve("@alchemy.run/cloudflare/D1/Database");
const owned = createRequire(cfEntry);
const sqlEntry = owned.resolve("@alchemy.run/sql/SqlFile");
const engine = await import(
  pathToFileURL(owned.resolve("@alchemy.run/sql/Migrations")).href
);
const parser = await import(pathToFileURL(sqlEntry).href);
const transport = await import(
  pathToFileURL(resolve(dirname(cfEntry), "ApplyMigrations.js")).href
);
for (const path of [
  resolve(dirname(cfEntry), "../../package.json"),
  resolve(dirname(sqlEntry), "../package.json"),
]) {
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).version,
    "2.0.0-beta.85",
  );
}
export interface OwnerMigrationRecord {
  name: string;
  hash: string;
  createdAtMillis: number | null;
  sql: string;
  statements: string[];
}
export const migrationSha = (sql: string) =>
  createHash("sha256").update(sql).digest("hex");
export async function ownerMigrationRecords(
  files: string[],
): Promise<OwnerMigrationRecord[]> {
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(files, [...files].sort());
  return Promise.all(
    files.map(async (file) => {
      const name = file.split("/").at(-1)!;
      assert.match(name, /^\d{4}_.+\.sql$/);
      const sql = await readFile(
        new URL(`../${file}`, import.meta.url),
        "utf8",
      );
      return {
        name,
        hash: migrationSha(sql),
        createdAtMillis: engine.timestampPrefixMillis(name),
        sql,
        statements: parser.splitSqlStatements(sql),
      };
    }),
  );
}
export async function applyOwnerMigrationRecords(
  db: D1Database,
  records: OwnerMigrationRecord[],
) {
  const executor = transport.makeD1MigrationExecutor((sql: string) =>
    Effect.tryPromise({
      try: async () => {
        // Alchemy's LocalD1Gateway uses this trigger-aware SQLite parser. DDL
        // and its actual engine bookkeeping commit in the same D1 batch.
        const statements: string[] = parser.splitSqliteStatements(sql);
        return {
          result: await db.batch(
            statements.map((statement) => db.prepare(statement)),
          ),
        };
      },
      catch: (cause) => cause,
    }),
  );
  await Effect.runPromise(
    engine.applyAlchemyFormat({
      executor,
      table: "__alchemy_migrations",
      records,
    }),
  );
}
export async function migrateOwnerDatabase(db: D1Database, files: string[]) {
  const records = await ownerMigrationRecords(files);
  await applyOwnerMigrationRecords(db, records);
  return records;
}
export const ownerMigrationLedger = async (db: D1Database) =>
  (
    await db
      .prepare("SELECT name,hash FROM __alchemy_migrations ORDER BY id")
      .all<{ name: string; hash: string }>()
  ).results;
