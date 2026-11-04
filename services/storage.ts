// Community storage without a Durable Object (docs/operator-payments.md 7).
// One SQL table; every atomic step is an explicit conditional write, so the
// same logic runs on D1 or a plain SQLite file.
import { check } from "../packages/protocol/index.ts";

export interface AsyncStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Deletes and returns in one statement, so only one caller can consume a value. */
  take<T>(key: string): Promise<T | undefined>;
  insertIfAbsent(key: string, value: unknown): Promise<boolean>;
  /**
   * Inserts only while fewer than `limit` keys share `prefix`, in one
   * statement, so the count check and the insert cannot be separated.
   */
  insertIfCountBelow(key: string, value: unknown, prefix: string, limit: number): Promise<boolean>;
  /** Applies `next` with compare-and-set on the stored text, retrying on races. */
  update<T>(key: string, next: (current: T | undefined) => T): Promise<T>;
  entries(prefix: string): Promise<{ key: string; value: unknown }[]>;
  now(): Promise<number>;
}

export class D1Store implements AsyncStore {
  private ready?: Promise<unknown>;
  constructor(
    readonly db: D1Database,
    readonly initialNow = 1800000000,
  ) {}
  private init() {
    this.ready ??= this.db
      .prepare("CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
      .run();
    return this.ready;
  }
  private async raw(key: string) {
    await this.init();
    const row = await this.db
      .prepare("SELECT value FROM records WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value;
  }
  async get<T>(key: string) {
    const text = await this.raw(key);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }
  async set(key: string, value: unknown) {
    await this.init();
    await this.db
      .prepare("INSERT OR REPLACE INTO records (key, value) VALUES (?, ?)")
      .bind(key, JSON.stringify(value))
      .run();
  }
  async delete(key: string) {
    await this.init();
    await this.db.prepare("DELETE FROM records WHERE key = ?").bind(key).run();
  }
  async take<T>(key: string) {
    await this.init();
    const row = await this.db
      .prepare("DELETE FROM records WHERE key = ? RETURNING value")
      .bind(key)
      .first<{ value: string }>();
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  async insertIfAbsent(key: string, value: unknown) {
    await this.init();
    const result = await this.db
      .prepare("INSERT INTO records (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
      .bind(key, JSON.stringify(value))
      .run();
    return result.meta.changes === 1;
  }
  async insertIfCountBelow(key: string, value: unknown, prefix: string, limit: number) {
    await this.init();
    const result = await this.db
      .prepare(
        "INSERT INTO records (key, value) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM records WHERE substr(key, 1, length(?3)) = ?3) < ?4 ON CONFLICT(key) DO NOTHING",
      )
      .bind(key, JSON.stringify(value), prefix, limit)
      .run();
    return result.meta.changes === 1;
  }
  async update<T>(key: string, next: (current: T | undefined) => T) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = await this.raw(key);
      const value = next(before === undefined ? undefined : (JSON.parse(before) as T));
      const text = JSON.stringify(value);
      const result =
        before === undefined
          ? await this.db
              .prepare("INSERT INTO records (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
              .bind(key, text)
              .run()
          : await this.db
              .prepare("UPDATE records SET value = ? WHERE key = ? AND value = ?")
              .bind(text, key, before)
              .run();
      if (result.meta.changes === 1) return value;
    }
    throw new Error("store_contention");
  }
  async entries(prefix: string) {
    await this.init();
    const rows = await this.db
      // Prefix match without LIKE: D1 refuses long LIKE patterns.
      .prepare("SELECT key, value FROM records WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key")
      .bind(prefix)
      .all<{ key: string; value: string }>();
    return rows.results.map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown }));
  }
  async now() {
    return (await this.get<number>("clock")) ?? this.initialNow;
  }
}

/** Local fixture clock, fault switch and state dump, guarded by LOCAL_ONLY. */
export async function localControl(path: string, request: Request, store: AsyncStore) {
  if (path === "/__clock") {
    const { now } = (await request.json()) as { now: number };
    check(Number.isSafeInteger(now) && now >= (await store.now()), "clock_backwards");
    await store.set("clock", now);
    return { now };
  }
  if (path === "/__fault") {
    const { key, value } = (await request.json()) as { key: string; value: unknown };
    check(/^fault:[a-z-]{1,40}$/.test(key), "invalid_fault");
    if (value === null) await store.delete(key);
    else await store.set(key, value);
    return { key };
  }
  if (path === "/__state") return store.entries("");
  return undefined;
}
