/** Actual production Store/index SQL on memory SQLite. Metadata fixtures are
 * intentionally partial; this proves lookup, never complete admission. */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../services/operator-store.ts";
const communityId = `0x${"ab".repeat(32)}`,
  learner = `0x${"cd".repeat(20)}`;
const target = { chainId: 6343, version: 4, contract: `0x${"ef".repeat(20)}` };
function metadata(id: string) {
  return {
    offer: {
      lessonId: id,
      speechChannel: "telegram-linked",
      learner,
      telegramFence: { facts: { actor: { communityId } } },
    },
    target,
  };
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE records(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const queries: { sql: string; args: (string | number | null)[] }[] = [];
  const storage = {
    sql: {
      exec(sql: string, ...args: (string | number | null)[]) {
        queries.push({ sql, args });
        const rows = db.prepare(sql).all(...args);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T) {
      db.exec("SAVEPOINT fixture_index");
      try {
        const x = fn();
        db.exec("RELEASE fixture_index");
        return x;
      } catch (e) {
        db.exec("ROLLBACK TO fixture_index");
        db.exec("RELEASE fixture_index");
        throw e;
      }
    },
  } as unknown as DurableObjectStorage;
  return { db, storage, queries, store: () => new Store(storage) };
}

test("indexed keyset pages include preexisting accepted bindings without any D1 row or entries scan", () => {
  const f = fixture();
  try {
    const put = f.db.prepare("INSERT INTO records VALUES(?,?)");
    const expected: string[] = [];
    for (let i = 0; i < 123; i++) {
      const id = "fixture_" + String(i).padStart(5, "0"),
        key = "studyBinding:" + id;
      const row = metadata(id);
      if (i % 2 === 0) {
        row.offer.learner = learner.toUpperCase();
        row.target = { ...target, contract: target.contract.toUpperCase() };
      }
      put.run(key, JSON.stringify(row));
      expected.push(key);
      put.run(
        "studyBinding:other_" + id,
        JSON.stringify({
          ...metadata(id),
          target: { ...target, chainId: 31337 },
        }),
      );
      put.run(
        "studyBinding:website_" + id,
        JSON.stringify({ offer: { lessonId: id, learner }, target }),
      );
    }
    let store = f.store();
    store.entries = () => {
      throw Error("unbounded entries scan forbidden");
    };
    assert.equal(store.linkedStudyBindings.hasUnclassified(), false);
    let after = "studyBinding:";
    const actual: string[] = [];
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      const page = store.linkedStudyBindings.page({
        communityId,
        learner,
        target,
        after,
        limit: 50,
      });
      assert.ok(page.length <= 50);
      if (!page.length) break;
      actual.push(...page.map((row) => row.key));
      after = page.at(-1)!.key;
      store = f.store();
      store.entries = () => {
        throw Error("entries forbidden after restart");
      };
    }
    assert.deepEqual(actual, expected);
    const query = f.queries.findLast((q) =>
      q.sql.includes(
        "SELECT key,value FROM records INDEXED BY records_linked_study_discovery",
      ),
    )!;
    const plan = f.db
      .prepare("EXPLAIN QUERY PLAN " + query.sql)
      .all(...query.args);
    assert.ok(
      plan.some((row) =>
        String(row.detail).includes(
          "SEARCH records USING INDEX records_linked_study_discovery",
        ),
      ),
      JSON.stringify(plan),
    );
    assert.ok(
      !plan.some((row) => String(row.detail).includes("TEMP B-TREE")),
      JSON.stringify(plan),
    );
    assert.throws(
      () =>
        store.linkedStudyBindings.page({
          communityId,
          learner,
          target,
          after: "outside",
          limit: 50,
        }),
      /invalid_study_binding_discovery/,
    );
    assert.throws(
      () =>
        store.linkedStudyBindings.page({
          communityId,
          learner,
          target,
          after,
          limit: 51,
        }),
      /invalid_study_binding_discovery/,
    );
  } finally {
    f.db.close();
  }
});

test("unclassifiable linked hints cannot vanish behind an indexed learner or target filter", () => {
  const variants = [
    { ...metadata("bad"), offer: { ...metadata("bad").offer, learner: null } },
    { ...metadata("bad"), target: null },
    { ...metadata("bad"), target: { ...target, chainId: 1 } },
    { ...metadata("bad"), target: { ...target, version: 3 } },
    {
      ...metadata("bad"),
      target: { ...target, contract: "0x" + "0".repeat(40) },
    },
    {
      ...metadata("bad"),
      offer: {
        ...metadata("bad").offer,
        telegramFence: { facts: { actor: { communityId: null } } },
      },
    },
    {
      ...metadata("bad"),
      offer: { ...metadata("bad").offer, speechChannel: "unknown" },
    },
    {
      offer: { lessonId: "bad", privateSpeechSource: { public: true } },
      target,
    },
  ];
  for (const row of variants) {
    const f = fixture();
    try {
      f.db
        .prepare("INSERT INTO records VALUES(?,?)")
        .run("studyBinding:bad", JSON.stringify(row));
      const store = f.store();
      assert.equal(
        store.linkedStudyBindings.hasUnclassified(),
        true,
        JSON.stringify(row),
      );
      const query = f.queries.findLast((q) =>
        q.sql.startsWith(
          "SELECT 1 FROM records INDEXED BY records_unclassified_linked_study_binding",
        ),
      )!;
      const plan = f.db.prepare("EXPLAIN QUERY PLAN " + query.sql).all();
      assert.ok(
        plan.some((row) =>
          String(row.detail).includes(
            "records_unclassified_linked_study_binding",
          ),
        ),
        JSON.stringify(plan),
      );
    } finally {
      f.db.close();
    }
  }
});
