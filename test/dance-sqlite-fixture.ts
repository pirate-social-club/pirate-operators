/** Memory-only SQLite executes the ACTUAL Dance schema/statements. This is a
 * small D1-shaped test adapter, not D1/Worker or actual media-producer evidence. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { insist } from "../packages/community/common.ts";
import type {
  DanceCapture,
  DanceFence,
  DanceReadyMedia,
} from "../packages/dance/contracts.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import { DanceReviewService } from "../services/dance-review.ts";
import { danceFixture, dh } from "./dance-fixture.ts";

export class SqliteStatement {
  readonly db: MemorySqliteD1;
  readonly sql: string;
  readonly values: (string | number | null)[];
  constructor(
    db: MemorySqliteD1,
    sql: string,
    values: (string | number | null)[] = [],
  ) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }
  bind(...values: (string | number | null)[]) {
    return new SqliteStatement(this.db, this.sql, values);
  }
  async first<T>() {
    await this.db.beforeRead?.(this.sql);
    return (
      (this.db.sqlite.prepare(this.sql).get(...this.values) as T | undefined) ??
      null
    );
  }
  async all<T>() {
    await this.db.beforeRead?.(this.sql);
    return {
      results: this.db.sqlite.prepare(this.sql).all(...this.values) as T[],
      success: true,
    };
  }
  async run() {
    return this.db.sqlite.prepare(this.sql).run(...this.values);
  }
}
export class MemorySqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  executed: string[] = [];
  beforeBatch:
    | ((statements: SqliteStatement[]) => void | Promise<void>)
    | null = null;
  afterBatch: (() => void) | null = null;
  beforeRead: ((sql: string) => void | Promise<void>) | null = null;
  prepare(sql: string) {
    return new SqliteStatement(this, sql);
  }
  async batch(statements: SqliteStatement[]) {
    const before = this.beforeBatch;
    this.beforeBatch = null;
    await before?.(statements);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        this.executed.push(statement.sql);
        this.sqlite.prepare(statement.sql).run(...statement.values);
      }
      this.sqlite.exec("COMMIT");
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
    const after = this.afterBatch;
    this.afterBatch = null;
    after?.();
    return [];
  }
  asD1() {
    return this as unknown as D1Database;
  }
  count(table: string) {
    return Number(
      this.sqlite.prepare("SELECT count(*) n FROM " + table).get()!.n,
    );
  }
  close() {
    this.sqlite.close();
  }
}

export function sqliteDanceFixture() {
  const model = danceFixture();
  model.store.time = Date.now();
  const db = new MemorySqliteD1();
  db.sqlite.exec("PRAGMA foreign_keys=ON");
  db.sqlite.exec(
    readFileSync(
      new URL("../packages/dance/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  // Explicit producer PLAN FIXTURE. Actual source3 plan/mount remains a gate.
  db.sqlite.exec(
    "CREATE TABLE fixture_media(id TEXT PRIMARY KEY,revision INTEGER,digest TEXT,expires_at INTEGER,state TEXT); CREATE TABLE community_media_submissions(submission_id TEXT PRIMARY KEY,community_id TEXT,account_id TEXT,media_id TEXT UNIQUE,binding_commitment TEXT,submitted_at_ms INTEGER,deadline_ms INTEGER,media_revision INTEGER)",
  );
  db.sqlite.function("fixture_guard", (key) =>
    Number(model.store.checks.get(String(key))?.() ?? false),
  );
  const convert = (f: DanceFence): DanceFence => ({
    sql: "fixture_guard(?)",
    values: [f.sql],
  });
  const base = model.ports;
  const ports = {
    ...base,
    authority: async (...args: Parameters<typeof base.authority>) => {
      const f = await base.authority(...args);
      return { ...f, fence: convert(f.fence) };
    },
    admitCapture: async (...args: Parameters<typeof base.admitCapture>) => {
      const f = await base.admitCapture(...args);
      return { ...f, fence: convert(f.fence) };
    },
    rules: async (...args: Parameters<typeof base.rules>) =>
      convert(await base.rules(...args)),
    authorization: async (...args: Parameters<typeof base.authorization>) =>
      convert(await base.authorization(...args)),
    reviewerAuthorization: async (
      ...args: Parameters<typeof base.reviewerAuthorization>
    ) => convert(await base.reviewerAuthorization(...args)),
    media: { ...base.media },
  };
  const store = new DanceStore(db.asD1());
  const service = new DanceReviewService(store, ports, dh(1));
  const ready = async (id: string) => {
    const m = model.media.get(id);
    const state = db.sqlite
      .prepare("SELECT * FROM fixture_media WHERE id=?")
      .get(id);
    insist(
      m && state?.state === "ready" && Number(state.expires_at) > Date.now(),
      "media_unavailable",
      410,
    );
    const media = {
      ...m,
      revision: Number(state.revision),
      expiresAt: Number(state.expires_at),
    };
    return {
      media,
      witness: {
        id,
        communityId: m.communityId,
        accountId: m.accountId,
        revision: media.revision,
        recordingSha256: m.recordingSha256,
        expiresAt: media.expiresAt,
      },
    };
  };
  ports.media.readyForSubmission = async (id, _binding, actor) => {
    const result = await ready(id);
    insist(actor.accountId === result.media.accountId, "media_not_found", 404);
    return result;
  };
  ports.media.readyForReview = async (id, _binding, actor) => {
    const result = await ready(id);
    insist(
      actor.accountId !== result.media.accountId,
      "dance_self_review",
      403,
    );
    return result;
  };
  ports.media.commitFence = (w) => ({
    sql:
      "EXISTS(SELECT 1 FROM fixture_media WHERE id=? AND revision=? AND digest=? AND expires_at=? AND state='ready' AND expires_at>" +
      DANCE_DB_NOW +
      ")",
    values: [w.id, w.revision, w.recordingSha256, w.expiresAt],
  });
  const guard = (f: DanceFence) =>
    store.stmt(
      "INSERT INTO dance_transaction_guards VALUES(?,CASE WHEN (" +
        f.sql +
        ") THEN 1 ELSE 0 END)",
      crypto.randomUUID(),
      ...f.values,
    );
  ports.media.prepareMediaSubmission = (w, id, binding, accepted) => ({
    beforeAcceptance: [
      store.stmt(
        "INSERT INTO community_media_submissions SELECT ?,?,?,?,?," +
          DANCE_DB_NOW +
          "," +
          DANCE_DB_NOW +
          "+604800000,?",
        id,
        w.communityId,
        w.accountId,
        w.id,
        binding,
        w.revision + 1,
      ),
      store.stmt(
        "UPDATE fixture_media SET revision=revision+1,expires_at=(SELECT deadline_ms FROM community_media_submissions WHERE submission_id=?) WHERE id=? AND revision=? AND digest=? AND expires_at=? AND state='ready'",
        id,
        w.id,
        w.revision,
        w.recordingSha256,
        w.expiresAt,
      ),
      store.changed(),
    ],
    afterAcceptance: [guard(accepted)],
  });
  let sequence = 0;
  async function capture() {
    return service.capture(
      "learner",
      "capture_" + ++sequence,
      { songKey: dh(10), offerId: null, referenceId: null },
      model.consent,
    );
  }
  async function addMedia(c: DanceCapture) {
    const id = "media_" + ++sequence;
    const m: DanceReadyMedia = {
      version: "pirate.community-media/1",
      id,
      revision: 1,
      purpose: "private-review",
      rendition: {
        sha256: dh(99),
        bytes: 1,
        durationMs: 10000,
        width: 1,
        height: 1,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      communityId: c.communityId,
      accountId: c.learner.accountId,
      songKey: c.songKey,
      songRevision: c.songRevision,
      audioSha256: c.audioSha256,
      mediaPolicyVersion: c.mediaPolicyVersion,
      recordingSha256: dh(100 + sequence),
      startSample: c.startSample,
      durationSamples: c.durationSamples,
      readyAt: Date.now(),
      expiresAt: Date.now() + 172800000,
    };
    model.media.set(id, m);
    db.sqlite
      .prepare("INSERT INTO fixture_media VALUES(?,?,?,?,'ready')")
      .run(id, 1, m.recordingSha256, m.expiresAt);
    return m;
  }
  async function pending() {
    const c = await capture(),
      m = await addMedia(c),
      command = "submit_" + sequence;
    await service.submit(
      "learner",
      command,
      c.captureId,
      m.id,
      m.recordingSha256,
    );
    return {
      capture: c,
      media: m,
      command,
      review: await store.review(c.captureId),
    };
  }
  return {
    db,
    store,
    ports,
    service,
    model,
    capture,
    addMedia,
    pending,
    close: () => db.close(),
  };
}
