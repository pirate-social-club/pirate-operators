import assert from "node:assert/strict";
import { fstatSync, lstatSync, readdirSync, readlinkSync, realpathSync, type BigIntStats } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Store } from "../../services/operator-store.ts";
import type { OperationLease } from "./backend-state.ts";

type StoreIdentity = Readonly<{ path: string; device: string; inode: string; journalId: `0x${string}` }>;
const connections = new WeakMap<object, {
  lease: OperationLease;
  assertConnected(expected: StoreIdentity): Promise<void>;
}>();
const proc = "/proc/self/fd";
const markerKey = "publicationOperatorIdentity:v1";

function fileDescriptors() {
  const open = new Map<number, string>();
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    try { open.set(Number(entry), readlinkSync(proc + "/" + entry)); }
    catch (error) {
      // The directory reader's transient descriptor is already closed.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return open;
}

/** The owning callback opens the existing original itself. The Store and its
 * connection proof cannot be supplied by a selection record or existing handle. */
export async function openPinnedNativeDanceOperatorStore(input: {
  identity: StoreIdentity;
  lease: OperationLease;
  readOnly: boolean;
}) {
  const { lease, readOnly } = input;
  const identity = { ...input.identity };
  const { path } = identity;
  await lease.assertHeld();

  function assertPhysical(stats: BigIntStats) {
    assert(stats.isFile() && stats.nlink === 1n && stats.uid === BigInt(process.getuid!()) &&
      !(stats.mode & 0o077n) && String(stats.dev) === identity.device && String(stats.ino) === identity.inode,
      "native_dance_connected_store_changed");
  }
  function assertNamed() {
    assert(realpathSync(path) === path, "native_dance_connected_store_changed");
    assertPhysical(lstatSync(path, { bigint: true }));
  }

  assertNamed();
  const uri = pathToFileURL(path);
  uri.searchParams.set("mode", readOnly ? "ro" : "rw");
  const sqlite = new DatabaseSync(uri.href, { open: false, readOnly });
  try {
    // This synchronous interval owns the only main-file open for this private
    // database. Count the descriptor created by SQLite before exposing its Store.
    const before = fileDescriptors();
    sqlite.open();
    const mains = [...fileDescriptors()].filter(([fd, name]) =>
      !before.has(fd) && (name === path || name === path + " (deleted)"));
    assert(mains.length === 1, "native_dance_connected_store_unavailable");
    const main = mains[0]![0];
    function assertConnection() {
      assert(sqlite.isOpen && sqlite.location("main") === path &&
        readlinkSync(proc + "/" + main) === path, "native_dance_connected_store_changed");
      assertPhysical(fstatSync(main, { bigint: true }));
      assertNamed();
    }
    assertConnection();

    // Require an established operator DB before Store's schema initialization.
    const marker = sqlite.prepare("SELECT value FROM records WHERE key = ?").get(markerKey);
    assert(typeof marker?.value === "string" &&
      JSON.parse(marker.value).journalId === identity.journalId, "native_dance_connected_store_changed");
    let savepoint = 0;
    const storage = {
      sql: { exec(query: string, ...parameters: SQLInputValue[]) {
        const statement = sqlite.prepare(query);
        const rows = statement.all(...parameters);
        return { toArray: () => rows };
      } },
      transactionSync<T>(work: () => T): T {
        const name = "pirate_public_dance_" + savepoint++;
        sqlite.exec("SAVEPOINT " + name);
        try {
          const result = work();
          sqlite.exec("RELEASE " + name);
          return result;
        } catch (error) {
          sqlite.exec("ROLLBACK TO " + name);
          sqlite.exec("RELEASE " + name);
          throw error;
        }
      },
    } as unknown as DurableObjectStorage;
    const store = new Store(storage, undefined, true);
    const assertConnected = async (expected: StoreIdentity) => {
      assert(expected.path === path && expected.device === identity.device && expected.inode === identity.inode &&
        expected.journalId === identity.journalId, "native_dance_connected_store_changed");
      await lease.assertHeld();
      assertConnection();
    };
    await assertConnected(identity);
    connections.set(store, { lease, assertConnected });
    return Object.freeze({ store, async close() {
      if (!sqlite.isOpen) return;
      sqlite.close();
      connections.delete(store);
    } });
  } catch (error) {
    if (sqlite.isOpen) sqlite.close();
    throw error;
  }
}

export async function assertPinnedNativeDanceStoreConnection(
  store: object, identity: StoreIdentity, lease: OperationLease,
) {
  const connection = connections.get(store);
  assert(connection, "native_dance_connected_store_unavailable");
  assert(connection.lease === lease, "native_dance_connected_store_lease_changed");
  await connection.assertConnected(identity);
}
