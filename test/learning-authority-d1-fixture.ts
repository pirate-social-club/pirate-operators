// Actual pinned Alchemy migration engine/parser over local workerd D1.
// The SQL gateway is local; no Cloudflare account, provider or network credential.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import { Miniflare } from "miniflare";

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
export interface AuthorityMigrationRecord {
  name: string;
  hash: string;
  createdAtMillis: number | null;
  sql: string;
  statements: string[];
}
const directory = new URL(
  "../apps/community-wizard/infra/migrations/",
  import.meta.url,
);
export const sha = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function authorityD1Fixture() {
  const runtime = new Miniflare({
    modules: true,
    script:
      "export default {fetch(){return new Response('local migration fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB");
    const names = (await readdir(directory))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    assert.deepEqual(
      names.map((name) => Number(name.slice(0, 4))),
      Array.from({ length: 18 }, (_, index) => index + 1),
    );
    const records: AuthorityMigrationRecord[] = await Promise.all(
      names.map(async (name) => {
        const sql = await readFile(new URL(name, directory), "utf8");
        return {
          name,
          hash: sha(sql),
          createdAtMillis: engine.timestampPrefixMillis(name),
          sql,
          statements: parser.splitSqlStatements(sql),
        };
      }),
    );
    const calls: Array<{
      hash: string;
      statements: number;
      authority: boolean;
    }> = [];
    let loseReply = false;
    const executor = transport.makeD1MigrationExecutor((sql: string) =>
      Effect.tryPromise({
        try: async () => {
          // The exact Alchemy LocalD1Gateway parser keeps trigger BEGIN/END intact.
          const statements: string[] = parser.splitSqliteStatements(sql);
          const authority = sql.includes(
            "CREATE TABLE learning_authority_heads",
          );
          calls.push({
            hash: sha(sql),
            statements: statements.length,
            authority,
          });
          const result = await db.batch(
            statements.map((statement) => db.prepare(statement)),
          );
          if (authority && loseReply) {
            loseReply = false;
            throw Error("fixture_reply_lost_after_D1_commit");
          }
          return { result };
        },
        catch: (cause) => cause,
      }),
    );
    const apply = (selected: AuthorityMigrationRecord[] = records) =>
      Effect.runPromise(
        engine.applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: selected,
        }),
      );
    const ledger = () =>
      db
        .prepare("SELECT name,hash FROM __alchemy_migrations ORDER BY id")
        .all<{ name: string; hash: string }>();
    return {
      db,
      records,
      calls,
      apply,
      ledger,
      loseNextAuthorityReply: () => {
        loseReply = true;
      },
      dispose: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
