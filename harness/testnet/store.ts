import { DatabaseSync } from "node:sqlite";
import { serialize, deserialize } from "node:v8";
import { chmodSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "mppx";
import { check } from "../../packages/protocol/index.ts";
import { privateStoreDirectory } from "./config.ts";

// One Node process per spike, with durable atomic SQLite updates. This adapter
// does not substitute for the planned Cloudflare Store conformance tests.
export class PrivateStore {
  readonly db: DatabaseSync;
  constructor(name: string, directory = privateStoreDirectory()) {
    const file = join(directory, name + ".sqlite");
    check(
      !existsSync(file) || !lstatSync(file).isSymbolicLink(),
      "private_store_symlink",
    );
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value BLOB NOT NULL)",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owner = this.read<{ pid: number }>("process-owner");
      if (owner) {
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
        check(!alive, "testnet_wallet_already_in_use");
      }
      this.write("process-owner", { pid: process.pid });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }
  read<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value FROM records WHERE key=?")
      .get(key) as { value: Uint8Array } | undefined;
    return row ? (deserialize(row.value) as T) : null;
  }
  write(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO records VALUES (?,?)")
      .run(key, serialize(value));
  }
  remove(key: string) {
    this.db.prepare("DELETE FROM records WHERE key=?").run(key);
  }
  adapter(prefix: string): Store.AtomicStore {
    return {
      get: async (key) => this.read(prefix + key),
      put: async (key, value) => this.write(prefix + key, value),
      delete: async (key) => this.remove(prefix + key),
      update: async (key, fn) => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const result = fn(this.read(prefix + key));
          if (result.op === "set") this.write(prefix + key, result.value);
          else if (result.op === "delete") this.remove(prefix + key);
          this.db.exec("COMMIT");
          return result.result;
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      },
    };
  }
  close() {
    this.remove("process-owner");
    this.db.close();
  }
}
