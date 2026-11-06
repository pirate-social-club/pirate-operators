// Private, crash-durable state for one manual activation. A separate SQLite
// lock database holds an OS lock for the run and releases it on process exit.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TxStore } from "../../services/operator-tx.ts";

export class ActivationJournal implements TxStore {
  private readonly lock: DatabaseSync;
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink())
      throw new Error("journal_directory_symlink");
    chmodSync(dirname(path), 0o700);
    for (const file of [path, `${path}.lock`]) {
      try {
        if (!lstatSync(file).isFile())
          throw new Error("journal_not_regular_file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.lock = new DatabaseSync(`${path}.lock`);
    chmodSync(`${path}.lock`, 0o600);
    try {
      this.lock.exec("BEGIN EXCLUSIVE");
    } catch {
      this.lock.close();
      throw new Error("activation_runner_already_running");
    }
    try {
      this.db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      this.db.exec(
        "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
    } catch (error) {
      this.lock.close();
      throw error;
    }
  }
  get<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM records WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO records VALUES (?,?)")
      .run(key, JSON.stringify(value));
  }
  delete(key: string) {
    this.db.prepare("DELETE FROM records WHERE key=?").run(key);
  }
  entries(prefix: string) {
    return (
      this.db
        .prepare(
          "SELECT key,value FROM records WHERE substr(key,1,?)=? ORDER BY key",
        )
        .all(prefix.length, prefix) as { key: string; value: string }[]
    ).map((row) => ({ key: row.key, value: JSON.parse(row.value) as unknown }));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
    this.lock.close();
  }
}
