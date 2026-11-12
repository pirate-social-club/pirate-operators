/** SIMULATED durable transaction boundary, not IndexedDB evidence. Every
 * journal operation below is the production implementation. Failure hooks
 * distinguish rollback from committed data whose acknowledgement is lost. */
import {
  danceJournalOperations,
  type DanceJournalState,
  type DanceJournalTransaction,
} from "../src/dance/journal.ts";
export function simulatedCommandStorage() {
  const rows = new Map<string, DanceJournalState>();
  let serial = Promise.resolve();
  const boundary = {
    beforeCommit: (() => {}) as () => void,
    afterCommit: (() => {}) as () => void,
  };
  const transact: DanceJournalTransaction = async (scope, write, use) => {
    const previous = serial;
    let unlock!: () => void;
    serial = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      const key = JSON.stringify([scope.communityId, scope.accountId]);
      const state = structuredClone(
        rows.get(key) ?? { active: null, accepted: {} },
      );
      const value = use(state);
      if (write) {
        boundary.beforeCommit();
        rows.set(key, structuredClone(state));
        boundary.afterCommit();
      }
      return structuredClone(value);
    } finally {
      unlock();
    }
  };
  return { journal: () => danceJournalOperations(transact), rows, boundary };
}
