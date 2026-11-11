// Actual pinned Alchemy parser/executor over local workerd D1; no provider.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { authorityD1Fixture, sha } from "./learning-authority-d1-fixture.ts";

const profileTables = (f: Awaited<ReturnType<typeof authorityD1Fixture>>) =>
  f.db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'community_profile%' ORDER BY name",
    )
    .all<{ name: string }>();

test("actual Alchemy applies contiguous1 through19 and the exact independently owned profile DDL once", async () => {
  const f = await authorityD1Fixture(19);
  try {
    const original = await readFile(
      new URL("../packages/community-profile/schema.sql", import.meta.url),
      "utf8",
    );
    assert.equal(f.records.at(-1)!.name, "0019_community_profiles.sql");
    assert.equal(
      f.records.at(-1)!.sql.split("\n").slice(1).join("\n"),
      original.split("\n").slice(1).join("\n"),
    );
    await f.apply();
    assert.deepEqual(
      (await f.ledger()).results,
      f.records.map(({ name, hash }) => ({ name, hash })),
    );
    assert.deepEqual(
      (await profileTables(f)).results.map((row) => row.name),
      [
        "community_profile_activity_cursors",
        "community_profile_mutations",
        "community_profiles",
      ],
    );
    assert.equal(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='index' AND name='community_profile_cursor_expiry'",
        )
        .first("n"),
      1,
    );
    const ledger = (await f.ledger()).results;
    const calls = f.calls.length;
    await f.apply();
    assert.equal(f.calls.length, calls);
    assert.deepEqual((await f.ledger()).results, ledger);
    assert.deepEqual(
      (await f.db.prepare("PRAGMA foreign_key_check").all()).results,
      [],
    );
  } finally {
    await f.dispose();
  }
});

test("upgrade18 to19 preserves credentials, sessions, settings and their authority revisions", async () => {
  const f = await authorityD1Fixture(19);
  try {
    await f.apply(f.records.slice(0, 18));
    await f.db.batch([
      f.db.prepare(
        "INSERT INTO community_accounts VALUES('migration-account','migration-author',10)",
      ),
      f.db
        .prepare(
          "INSERT INTO credential_bindings VALUES('migration-binding','migration-account','moss',6343,?,10)",
        )
        .bind("0x" + "11".repeat(20)),
      f.db.prepare(
        "INSERT INTO learning_settings VALUES('migration-account',100,100,NULL)",
      ),
      f.db
        .prepare(
          "INSERT INTO community_sessions VALUES(?,?,?,'migration-account','migration-binding',?,?)",
        )
        .bind(
          "a".repeat(64),
          "0x" + "12".repeat(32),
          "https://community.example",
          "b".repeat(64),
          2000000000000,
        ),
    ]);
    const names = [
      "community_accounts",
      "credential_bindings",
      "community_sessions",
      "learning_settings",
      "learning_authority_credentials",
    ];
    const snapshot = async () =>
      Promise.all(
        names.map(
          async (name) =>
            (await f.db.prepare(`SELECT * FROM ${name}`).all()).results,
        ),
      );
    const before = await snapshot();
    const prefix = (await f.ledger()).results;
    await f.apply();
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await f.ledger()).results.slice(0, 18), prefix);
    assert.equal((await f.ledger()).results.length, 19);
    assert.deepEqual(
      (await profileTables(f)).results.map((row) => row.name),
      [
        "community_profile_activity_cursors",
        "community_profile_mutations",
        "community_profiles",
      ],
    );
  } finally {
    await f.dispose();
  }
});

test("profile19 DDL and Alchemy bookkeeping roll back together on a later statement failure", async () => {
  const f = await authorityD1Fixture(19);
  try {
    await f.apply(f.records.slice(0, 18));
    const ledger = (await f.ledger()).results;
    const last = f.records.at(-1)!;
    const sql = last.sql + "\nSELECT * FROM fixture_missing_profile_table;";
    const broken = { ...last, sql, hash: sha(sql), statements: [sql] };
    await assert.rejects(
      f.apply([...f.records.slice(0, 18), broken]),
      /fixture_missing_profile_table/,
    );
    assert.deepEqual((await profileTables(f)).results, []);
    assert.deepEqual((await f.ledger()).results, ledger);
    await f.apply();
    assert.equal((await f.ledger()).results.length, 19);
    assert.equal((await profileTables(f)).results.length, 3);
  } finally {
    await f.dispose();
  }
});
