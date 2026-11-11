import { check } from "../packages/protocol/index.ts";
import {
  linkedStudyBindingIndex,
  type LinkedStudyBindingIndex,
} from "./study-linked-binding-index.ts";

export class Store {
  readonly sql: SqlStorage;
  readonly linkedStudyBindings: LinkedStudyBindingIndex;
  private readonly storage: DurableObjectStorage;
  readonly initialNow: number;
  private readonly liveClock: boolean;
  constructor(
    storage: DurableObjectStorage,
    initialNow = 1800000000,
    liveClock = false,
  ) {
    this.storage = storage;
    this.initialNow = initialNow;
    this.liveClock = liveClock;
    this.sql = storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.linkedStudyBindings = linkedStudyBindingIndex(this.sql);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS records_transaction_ref
      ON records(json_extract(value,'$.ref')) WHERE key>='tx:' AND key<'tx;'`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS records_speech_lesson
      ON records(json_extract(value,'$.parameters.lessonId')) WHERE key>='studySpeech:' AND key<'studySpeech;'`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS records_study_binding_channel
      ON records(json_extract(value,'$.offer.speechChannel')) WHERE key>='studyBinding:' AND key<'studyBinding;'`);
    this.sql
      .exec(`CREATE INDEX IF NOT EXISTS records_unclassified_transaction_ref
      ON records(key) WHERE key>='tx:' AND key<'tx;'
        AND COALESCE(json_type(value,'$.ref'),'')!='text'`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS records_unclassified_speech_lesson
      ON records(key) WHERE key>='studySpeech:' AND key<'studySpeech;'
        AND COALESCE(json_type(value,'$.parameters.lessonId'),'')!='text'`);
  }
  get<T>(key: string): T | undefined {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM records WHERE key = ?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  set(key: string, value: unknown) {
    this.sql.exec(
      "INSERT OR REPLACE INTO records VALUES (?, ?)",
      key,
      JSON.stringify(value),
    );
  }
  delete(key: string) {
    this.sql.exec("DELETE FROM records WHERE key = ?", key);
  }
  entries(prefix: string) {
    return this.sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM records WHERE key LIKE ? ORDER BY key",
        `${prefix}%`,
      )
      .toArray()
      .map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown }));
  }
  /** Bounded keyset scan over the primary key, without LIKE pattern limits. */
  page(prefix: string, after: string, limit: number) {
    check(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 100,
      "invalid_store_page",
    );
    check(after >= prefix && after < prefix + "\uffff", "invalid_store_cursor");
    return this.sql
      .exec<{ key: string; value: string }>(
        "SELECT key,value FROM records WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?",
        prefix,
        prefix + "\uffff",
        after,
        limit,
      )
      .toArray()
      .map((row) => ({
        key: row.key,
        value: JSON.parse(row.value) as unknown,
      }));
  }
  rangeExists(prefix: string, exceptKey: string | null = null) {
    return (
      this.sql
        .exec(
          "SELECT 1 FROM records WHERE key>=? AND key<? AND (? IS NULL OR key!=?) LIMIT 1",
          prefix,
          prefix + "\uffff",
          exceptKey,
          exceptKey,
        )
        .toArray().length > 0
    );
  }
  studyTransactionExists(refPrefix: string, exceptKey: string | null = null) {
    // Unclassifiable native rows cannot prove absence of this lesson's work.
    if (
      this.sql
        .exec(
          "SELECT 1 FROM records INDEXED BY records_unclassified_transaction_ref WHERE key>='tx:' AND key<'tx;' AND COALESCE(json_type(value,'$.ref'),'')!='text' LIMIT 1",
        )
        .toArray().length
    )
      return true;
    return (
      this.sql
        .exec(
          `SELECT 1 FROM records INDEXED BY records_transaction_ref WHERE key>='tx:' AND key<'tx;'
       AND json_extract(value,'$.ref')>=? AND json_extract(value,'$.ref')<?
       AND (? IS NULL OR key!=?) LIMIT 1`,
          refPrefix,
          refPrefix + "\uffff",
          exceptKey,
          exceptKey,
        )
        .toArray().length > 0
    );
  }
  studyChargedSponsorExists(prefix: string, exceptKey: string | null = null) {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM records WHERE key>=? AND key<?
       AND COALESCE(json_extract(value,'$.state'),'') NOT IN ('reserved','released')
       AND (? IS NULL OR key!=?) LIMIT 1`,
          prefix,
          prefix + "\uffff",
          exceptKey,
          exceptKey,
        )
        .toArray().length > 0
    );
  }
  studySpeechExists(lessonId: string) {
    if (this.rangeExists("studySpeechSlot:" + lessonId + ":")) return true;
    if (
      this.sql
        .exec(
          `SELECT 1 FROM records INDEXED BY records_unclassified_speech_lesson
      WHERE key>='studySpeech:' AND key<'studySpeech;'
      AND COALESCE(json_type(value,'$.parameters.lessonId'),'')!='text' LIMIT 1`,
        )
        .toArray().length
    )
      return true;
    return (
      this.sql
        .exec(
          `SELECT 1 FROM records INDEXED BY records_speech_lesson
      WHERE key>='studySpeech:' AND key<'studySpeech;'
      AND json_extract(value,'$.parameters.lessonId')=? LIMIT 1`,
          lessonId,
        )
        .toArray().length > 0
    );
  }
  hasLinkedStudyBinding() {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM records INDEXED BY records_study_binding_channel WHERE key>='studyBinding:' AND key<'studyBinding;'
       AND json_extract(value,'$.offer.speechChannel')='telegram-linked' LIMIT 1`,
        )
        .toArray().length > 0
    );
  }
  /** SQL binding writes and its durable wake commit together, including when
   * the request's original alarm already fired during chain admission. */
  async durableStudyWrite<T>(operation: () => T): Promise<T> {
    return this.storage.transaction(async () => {
      const result = operation();
      const due = Date.now() + 5000;
      const prior = await this.storage.getAlarm();
      if (prior === null || prior > due) await this.storage.setAlarm(due);
      return result;
    });
  }
  now() {
    if (this.liveClock) return Math.floor(Date.now() / 1000);
    return this.get<number>("clock") ?? this.initialNow;
  }
  /** Runs every write in `fn` as one SQLite transaction: all of them land, or none. */
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
