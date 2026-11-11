// Local workerd D1 + actual installed Alchemy parser/core/bookkeeping.
// This does not exercise Cloudflare's production HTTP resource/provider path.
import test from "node:test";
import assert from "node:assert/strict";
import { authorityD1Fixture, sha } from "./learning-authority-d1-fixture.ts";

const subject = "0x" + "11".repeat(20),
  nextSubject = "0x" + "22".repeat(20);
const original = "0x" + "aa".repeat(32);
async function seed(f: Awaited<ReturnType<typeof authorityD1Fixture>>) {
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO community_accounts VALUES('account-a','author-a',1),('account-b','author-b',1)",
    ),
    f.db
      .prepare(
        "INSERT INTO credential_bindings VALUES('binding-a','account-a','moss',6343,?,1)",
      )
      .bind(subject),
    f.db.prepare(
      "INSERT INTO learning_settings VALUES('account-a',1000,1000,NULL)",
    ),
    f.db
      .prepare(
        "INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,policy_hash,policy_version,issued_at,state,created_at,updated_at) VALUES(?,'account-a',?,'{}','frozen exact message','0x1234',?,4,100,'recorded',1,1)",
      )
      .bind(original, subject, "0x" + "bb".repeat(32)),
  ]);
  return f.db
    .prepare("SELECT * FROM learning_authorizations")
    .first<Record<string, unknown>>();
}
const tables = (f: Awaited<ReturnType<typeof authorityD1Fixture>>) =>
  f.db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'learning_authority_%' ORDER BY name",
    )
    .all<{ name: string }>();

test("actual Alchemy engine applies numbered1 through18 to workerd D1 and reruns without repeating authority DDL", async () => {
  const f = await authorityD1Fixture();
  try {
    await f.apply();
    assert.deepEqual(
      (await f.ledger()).results,
      f.records.map(({ name, hash }) => ({ name, hash })),
    );
    assert.equal((await tables(f)).results.length, 9);
    const ddl = f.calls.filter((call) => call.authority);
    assert.equal(ddl.length, 1);
    assert.ok(ddl[0]!.statements > 20);
    const triggers = await f.db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'learning_authority_%'",
      )
      .all();
    assert.equal(triggers.results.length, 15);
    await f.apply();
    assert.equal(f.calls.filter((call) => call.authority).length, 1);
    assert.equal((await f.ledger()).results.length, 18);
    assert.deepEqual(
      (await f.db.prepare("PRAGMA foreign_key_check").all()).results,
      [],
    );
  } finally {
    await f.dispose();
  }
});

test("numbered17 to18 preserves legacy bytes and invalidates original, credential and frozen membership revisions", async () => {
  const f = await authorityD1Fixture();
  try {
    await f.apply(f.records.slice(0, 17));
    const before = await seed(f);
    await f.apply();
    const after = await f.db
      .prepare("SELECT * FROM learning_authorizations")
      .first<Record<string, unknown>>();
    assert.equal(after!.authority_epoch, 0);
    const { authority_epoch: _epoch, ...preserved } = after!;
    assert.deepEqual(preserved, before);
    assert.equal(
      await f.db
        .prepare(
          "SELECT revision FROM learning_authority_original_heads WHERE account_id='account-a'",
        )
        .first("revision"),
      0,
    );
    assert.equal(
      await f.db
        .prepare(
          "SELECT version FROM learning_authority_dirty WHERE account_id='account-a'",
        )
        .first("version"),
      1,
    );
    await f.db
      .prepare(
        "UPDATE learning_authorizations SET tx_hash='receipt-only' WHERE authorization_id=?",
      )
      .bind(original)
      .run();
    assert.equal(
      await f.db
        .prepare(
          "SELECT revision FROM learning_authority_original_heads WHERE account_id='account-a'",
        )
        .first("revision"),
      0,
    );
    await f.db
      .prepare(
        "UPDATE learning_authorizations SET message='changed signed bytes' WHERE authorization_id=?",
      )
      .bind(original)
      .run();
    assert.equal(
      await f.db
        .prepare(
          "SELECT revision FROM learning_authority_original_heads WHERE account_id='account-a'",
        )
        .first("revision"),
      1,
    );
    await f.db
      .prepare(
        "UPDATE credential_bindings SET subject=? WHERE binding_id='binding-a'",
      )
      .bind(nextSubject)
      .run();
    assert.equal(
      await f.db
        .prepare(
          "SELECT revision FROM learning_authority_credentials WHERE account_id='account-a'",
        )
        .first("revision"),
      1,
    );
    await f.db
      .prepare(
        "UPDATE credential_bindings SET account_id='account-b' WHERE binding_id='binding-a'",
      )
      .run();
    assert.equal(
      await f.db
        .prepare(
          "SELECT revision FROM learning_authority_credentials WHERE account_id='account-a'",
        )
        .first("revision"),
      2,
    );
    assert.equal(
      await f.db
        .prepare(
          "SELECT revision FROM learning_authority_credentials WHERE account_id='account-b'",
        )
        .first("revision"),
      1,
    );
    await f.db
      .prepare(
        "INSERT INTO learning_authority_operations(operation_id,account_id,action_id,request_json,epoch,updated_at) VALUES('op','account-a','off','{}',1,1)",
      )
      .run();
    await f.db
      .prepare("INSERT INTO learning_authority_members VALUES('op',?,NULL)")
      .bind(original)
      .run();
    assert.equal(
      await f.db
        .prepare(
          "SELECT member_revision FROM learning_authority_operations WHERE operation_id='op'",
        )
        .first("member_revision"),
      1,
    );
    await f.db
      .prepare(
        "UPDATE learning_authority_members SET acknowledgment='retained receipt' WHERE operation_id='op'",
      )
      .run();
    assert.equal(
      await f.db
        .prepare(
          "SELECT member_revision FROM learning_authority_operations WHERE operation_id='op'",
        )
        .first("member_revision"),
      1,
    );
    await f.db
      .prepare(
        "UPDATE learning_authority_members SET authorization_id=? WHERE operation_id='op'",
      )
      .bind("0x" + "cc".repeat(32))
      .run();
    assert.equal(
      await f.db
        .prepare(
          "SELECT member_revision FROM learning_authority_operations WHERE operation_id='op'",
        )
        .first("member_revision"),
      2,
    );
    await f.db
      .prepare("DELETE FROM learning_authority_members WHERE operation_id='op'")
      .run();
    assert.equal(
      await f.db
        .prepare(
          "SELECT member_revision FROM learning_authority_operations WHERE operation_id='op'",
        )
        .first("member_revision"),
      3,
    );
    assert.equal(
      (await f.db.prepare("SELECT * FROM learning_authority_validation").all())
        .results.length,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("workerd D1 rolls back migration18 trigger/schema changes and Alchemy bookkeeping together on injected SQL failure", async () => {
  const f = await authorityD1Fixture();
  try {
    await f.apply(f.records.slice(0, 17));
    const before = await seed(f),
      ledger = (await f.ledger()).results;
    const last = f.records.at(-1)!,
      sql = last.sql + "\nSELECT * FROM fixture_missing_table;";
    const broken = { ...last, sql, hash: sha(sql), statements: [sql] };
    await assert.rejects(
      f.apply([...f.records.slice(0, 17), broken]),
      /fixture_missing_table/,
    );
    assert.deepEqual((await tables(f)).results, []);
    assert.deepEqual((await f.ledger()).results, ledger);
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM learning_authorizations").first(),
      before,
    );
    await f.apply();
    assert.equal((await f.ledger()).results.length, 18);
    assert.equal(
      await f.db
        .prepare("SELECT authority_epoch FROM learning_authorizations")
        .first("authority_epoch"),
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("lost post-commit migration18 reply reconciles Alchemy's actual ledger before any DDL replay", async () => {
  const f = await authorityD1Fixture();
  try {
    await f.apply(f.records.slice(0, 17));
    f.loseNextAuthorityReply();
    // The actual engine catches the lost reply and verifies its ledger itself.
    await f.apply();
    assert.equal(f.lostReplyCount(), 1);
    assert.equal((await f.ledger()).results.length, 18);
    const before = (await f.ledger()).results;
    await f.apply();
    assert.deepEqual((await f.ledger()).results, before);
    assert.equal(f.calls.filter((call) => call.authority).length, 1);
  } finally {
    await f.dispose();
  }
});
