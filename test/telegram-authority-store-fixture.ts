// Test transport provenance: SQLite savepoint/alarm adapter pattern from exact
// d410 test/learning-linked-withdrawal-fixture.ts. The actual Store, discovery
// index, source selection, bootstrap and proof/recovery are production modules.
// No authority result or completed bootstrap record is fabricated here.
import { DatabaseSync } from "node:sqlite";
import { Store } from "../services/operator-store.ts";
import {
  bootstrapLinkedWithdrawals,
  recoverLinkedWithdrawals,
} from "../services/study-linked-withdrawal-recovery.ts";
import { configuredWithdrawalPorts } from "../services/study-linked-withdrawal-ports.ts";
import {
  bootstrap,
  type WithdrawalSource,
} from "../services/study-linked-withdrawal-contract.ts";

/** Explicit Node SQLite + alarm emulator. This is not native DO acceptance.
 * Sources must come from the actual deployed local contract and runtime code. */
export function telegramAuthorityStoreFixture(options: {
  now(): number;
  sources: readonly WithdrawalSource[];
  rpcUrl: string;
}) {
  const database = new DatabaseSync(":memory:");
  let alarm: number | null = null,
    sequence = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const storage = {
    sql: {
      exec(query: string, ...args: (string | number | null)[]) {
        const rows = database.prepare(query).all(...args);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(work: () => T): T {
      const name = "telegram_authority_" + sequence++;
      database.exec("SAVEPOINT " + name);
      try {
        const value = work();
        database.exec("RELEASE " + name);
        return value;
      } catch (error) {
        database.exec("ROLLBACK TO " + name);
        database.exec("RELEASE " + name);
        throw error;
      }
    },
    transaction<T>(work: () => T | Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        const name = "telegram_authority_" + sequence++,
          priorAlarm = alarm;
        database.exec("SAVEPOINT " + name);
        try {
          const value = await work();
          database.exec("RELEASE " + name);
          return value;
        } catch (error) {
          alarm = priorAlarm;
          database.exec("ROLLBACK TO " + name);
          database.exec("RELEASE " + name);
          throw error;
        }
      });
      tail = result.catch(() => {});
      return result;
    },
    getAlarm: async () => alarm,
    setAlarm: async (at: number | Date) => {
      alarm = Number(at);
    },
  } as unknown as DurableObjectStorage;
  const store = new Store(storage, options.now(), false, options.sources);
  // Same explicit controlled clock used by actual local login/operator fixture.
  // Authority/discovery/proof methods remain the original production methods.
  store.now = options.now;
  const ports = configuredWithdrawalPorts(
    {
      RPC_URL: options.rpcUrl,
      STUDY_WITHDRAWAL_SOURCES_JSON: JSON.stringify(options.sources),
    },
    store,
  );
  return {
    store,
    database,
    sources: options.sources,
    alarm: () => alarm,
    bootstrapPage: () => bootstrapLinkedWithdrawals(store),
    async initialize() {
      for (
        let pages = 0;
        pages < 20 && bootstrap(store)?.phase !== "ready";
        pages++
      )
        await bootstrapLinkedWithdrawals(store);
      if (bootstrap(store)?.phase !== "ready")
        throw Error("fixture_linked_bootstrap_incomplete");
    },
    recover: () => recoverLinkedWithdrawals(store, ports),
    close: () => database.close(),
  };
}
