import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chargeSponsorship,
  releaseSponsorship,
  reserveSponsorship,
} from "../services/sponsor-budget.ts";
import type { TxStore } from "../services/operator-tx.ts";
function memory() {
  const rows = new Map<string, unknown>();
  const store: TxStore = {
    get: <T>(key: string) => rows.get(key) as T | undefined,
    set: (key, value) => {
      rows.set(key, value);
    },
    delete: (key) => {
      rows.delete(key);
    },
    entries: (prefix) =>
      [...rows]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    transaction: <T>(fn: () => T) => {
      const snapshot = new Map(rows);
      try {
        return fn();
      } catch (error) {
        rows.clear();
        for (const [k, v] of snapshot) rows.set(k, v);
        throw error;
      }
    },
  };
  return store;
}
const limits = { cap: 200n, gas: 9n, gasPrice: 10n, dataFee: 10n };
test("concurrent admissions and unknown outcomes cannot oversubscribe the total allowance", async () => {
  const store = memory();
  const attempts = await Promise.allSettled(
    ["a", "b", "c"].map(async (id) => reserveSponsorship(store, limits, id)),
  );
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 2);
  assert.throws(
    () => reserveSponsorship(store, limits, "d"),
    /sponsor_exhausted/,
  );
  chargeSponsorship(store, limits, "a");
  chargeSponsorship(store, limits, "a");
  releaseSponsorship(store, limits, "a"); // a reverted/unknown transaction is never refunded.
  assert.throws(
    () => reserveSponsorship(store, limits, "d"),
    /sponsor_exhausted/,
  );
  releaseSponsorship(store, limits, "b");
  reserveSponsorship(store, limits, "d");
  assert.deepEqual(store.get("sponsor:ledger"), {
    cap: "200",
    gas: "9",
    gasPrice: "10",
    dataFee: "10",
    spent: "100",
    reserved: "100",
  });
});
test("configuration changes and released references cannot silently refill the allowance", () => {
  const store = memory();
  reserveSponsorship(store, limits, "a");
  assert.throws(
    () => reserveSponsorship(store, { ...limits, cap: 300n }, "b"),
    /profile_changed/,
  );
  releaseSponsorship(store, limits, "a");
  assert.throws(
    () => reserveSponsorship(store, limits, "a"),
    /reservation_released/,
  );
});
