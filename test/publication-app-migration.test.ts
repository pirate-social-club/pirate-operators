import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { communityMigrations } from "../harness/package-migrations.ts";
import { authorityD1Fixture, sha } from "./learning-authority-d1-fixture.ts";

// Failure inventory: the new file must not silently enter existing profiles;
// explicit V5 journal selection must not require V4 consent; upgrades retain
// real accounts/sessions/settings, and DDL plus Alchemy ledger must roll back.
test("publication journal migration is explicit and independent of V4 authorization", async () => {
  const names = await readdir(
    new URL("../apps/community-wizard/infra/migrations/", import.meta.url),
  );
  const base = { rewards: false, ownerPublishing: false, v4: false };
  const historical = communityMigrations(names, base);
  assert.equal(historical.includes("0020_publication_consent.sql"), false);
  assert.equal(historical.at(-1), "0019_community_profiles.sql");
  const selected = communityMigrations(names, {
    ...base,
    publicationConsent: true,
  });
  assert.deepEqual(selected, [...historical, "0020_publication_consent.sql"]);
  assert.equal(selected.includes("0013_learning_authorization.sql"), false);
  assert.equal(selected.includes("0018_learning_authority.sql"), false);
});

const journalTables = async (
  f: Awaited<ReturnType<typeof authorityD1Fixture>>,
) =>
  (
    await f.db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'publication_v1_%' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results.map((row) => row.name);

test(
  "actual Alchemy upgrade19 to20 preserves login/settings and applies an empty consent journal once",
  { timeout: 30000 },
  async () => {
    const f = await authorityD1Fixture(20);
    try {
      await f.apply(f.records.slice(0, 19));
      await f.db.batch([
        f.db.prepare(
          "INSERT INTO community_accounts VALUES('retained-account','retained-author',10)",
        ),
        f.db
          .prepare(
            "INSERT INTO credential_bindings VALUES('retained-binding','retained-account','moss',6343,?,10)",
          )
          .bind("0x" + "11".repeat(20)),
        f.db.prepare(
          "INSERT INTO learning_settings VALUES('retained-account',100,100,NULL)",
        ),
        f.db
          .prepare(
            "INSERT INTO community_sessions VALUES(?,?,?,'retained-account','retained-binding',?,?)",
          )
          .bind(
            "a".repeat(64),
            "0x" + "12".repeat(32),
            "https://community.example",
            "b".repeat(64),
            2000000000000,
          ),
      ]);
      const snapshot = () =>
        Promise.all(
          [
            "community_accounts",
            "credential_bindings",
            "community_sessions",
            "learning_settings",
          ].map(
            async (table) =>
              (await f.db.prepare(`SELECT * FROM ${table}`).all()).results,
          ),
        );
      const before = await snapshot(),
        prefix = (await f.ledger()).results;
      await f.apply();
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual((await f.ledger()).results.slice(0, 19), prefix);
      assert.equal((await f.ledger()).results.length, 20);
      assert.deepEqual(await journalTables(f), [
        "publication_v1_commands",
        "publication_v1_heads",
        "publication_v1_observations",
      ]);
      for (const table of await journalTables(f))
        assert.equal(
          await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"),
          0,
        );
      assert.equal(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM setup_schema WHERE version=20")
          .first("n"),
        1,
      );
      const ledger = (await f.ledger()).results;
      await f.apply();
      assert.deepEqual((await f.ledger()).results, ledger);
      assert.deepEqual(
        (await f.db.prepare("PRAGMA foreign_key_check").all()).results,
        [],
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "actual Alchemy rolls publication DDL and ledger back together before a retry",
  { timeout: 30000 },
  async () => {
    const f = await authorityD1Fixture(20);
    try {
      await f.apply(f.records.slice(0, 19));
      const ledger = (await f.ledger()).results,
        last = f.records.at(-1)!;
      const sql =
        last.sql + "\nSELECT * FROM fixture_missing_publication_table;";
      await assert.rejects(
        f.apply([
          ...f.records.slice(0, 19),
          { ...last, sql, hash: sha(sql), statements: [sql] },
        ]),
        /fixture_missing_publication_table/,
      );
      assert.deepEqual(await journalTables(f), []);
      assert.deepEqual((await f.ledger()).results, ledger);
      await f.apply();
      assert.equal((await f.ledger()).results.length, 20);
      assert.equal((await journalTables(f)).length, 3);
    } finally {
      await f.dispose();
    }
  },
);
