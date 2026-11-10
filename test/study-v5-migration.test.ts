import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

test("unnumbered v5 migration preserves historical attempt bytes and owner uniqueness while admitting both revisions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE setup_schema(version INTEGER NOT NULL)");
    db.exec(
      readFileSync(
        new URL(
          "../apps/community-wizard/infra/migrations/0009_study.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    db.prepare(
      "INSERT INTO study_attempts(attempt_id,account_id,community_id,request_id,line_json,policy,started_at,state,grade_json) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      "historical",
      "account",
      "community",
      "request-old",
      '{"text":"frozen"}',
      "script_aware_token_phonetic_v4",
      1,
      "assessed",
      '{"correct":false,"heardTranscript":"frozen"}',
    );
    const before = db.prepare("SELECT * FROM study_attempts").all();
    db.exec("BEGIN");
    db.exec(
      readFileSync(
        new URL("../packages/study/grader-v5-migration.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec("COMMIT");
    assert.deepEqual(db.prepare("SELECT * FROM study_attempts").all(), before);
    const insert = db.prepare(
      "INSERT INTO study_attempts(attempt_id,account_id,community_id,request_id,line_json,policy,started_at,state) VALUES(?,?,?,?,?,?,?,'ready')",
    );
    insert.run(
      "new",
      "account",
      "community",
      "request-new",
      "{}",
      "script_aware_token_phonetic_v5",
      2,
    );
    assert.throws(
      () =>
        insert.run(
          "duplicate",
          "account",
          "community",
          "request-old",
          "{}",
          "script_aware_token_phonetic_v5",
          2,
        ),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        insert.run(
          "unknown",
          "account",
          "community",
          "request-other",
          "{}",
          "unreviewed-v6",
          2,
        ),
      /CHECK/,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
