import { telegramCheck } from "../packages/telegram/contracts.ts";

export interface TelegramJournal {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  entries<T>(
    prefix: string,
    limit?: number,
    after?: string,
  ): { key: string; value: T }[];
  transaction<T>(operation: () => T): T;
}
/** Own SQLite table, suitable for a coordinator-mounted community Durable Object.
 * Values leave no process-local authoritative cache; restart reads the journal. */
export class TelegramSqlJournal implements TelegramJournal {
  private readonly storage: Pick<
    DurableObjectStorage,
    "sql" | "transactionSync"
  >;
  constructor(storage: Pick<DurableObjectStorage, "sql" | "transactionSync">) {
    this.storage = storage;
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS telegram_journal (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  get<T>(key: string): T | undefined {
    const row = this.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM telegram_journal WHERE key=?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  set(key: string, value: unknown) {
    const json = JSON.stringify(value);
    telegramCheck(typeof json === "string", "telegram_storage_invalid");
    this.storage.sql.exec(
      "INSERT INTO telegram_journal VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      json,
    );
  }
  delete(key: string) {
    this.storage.sql.exec("DELETE FROM telegram_journal WHERE key=?", key);
  }
  entries<T>(prefix: string, limit = 1000, after = prefix) {
    telegramCheck(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 10_000,
      "telegram_scan_invalid",
    );
    return this.storage.sql
      .exec<{ key: string; value: string }>(
        "SELECT key,value FROM telegram_journal WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?",
        prefix,
        prefix + "\uffff",
        after,
        limit,
      )
      .toArray()
      .map((row) => ({ key: row.key, value: JSON.parse(row.value) as T }));
  }
  transaction<T>(operation: () => T): T {
    return this.storage.transactionSync(() => {
      const value = operation();
      telegramCheck(
        !(value && typeof value === "object" && "then" in value),
        "telegram_async_transaction_refused",
      );
      return value;
    });
  }
}
/** Bounded fair scan: one uncertain operation cannot permanently hide later
 * actors behind a fixed prefix page. The cursor itself is journaled. */
export function telegramScan<T>(
  store: TelegramJournal,
  prefix: string,
  limit: number,
) {
  const cursorKey = `scan:${prefix}`,
    after = store.get<string>(cursorKey);
  let rows = store.entries<T>(prefix, limit, after);
  if (!rows.length && after) rows = store.entries<T>(prefix, limit);
  if (rows.length) store.set(cursorKey, rows.at(-1)!.key);
  else store.delete(cursorKey);
  return rows;
}
