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
    () => reserveSponsorship(store, { ...limits, gas: 10n }, "b"),
    /profile_changed/,
  );
  releaseSponsorship(store, limits, "a");
  assert.throws(
    () => reserveSponsorship(store, limits, "a"),
    /reservation_released/,
  );
});

test("a manual ceiling increase preserves charges and outstanding reservations", () => {
  const store = memory();
  reserveSponsorship(store, limits, "a");
  chargeSponsorship(store, limits, "a");
  reserveSponsorship(store, limits, "b");
  const larger = { ...limits, cap: 300n };
  reserveSponsorship(store, larger, "c");
  assert.deepEqual(store.get("sponsor:ledger"), {
    cap: "300",
    gas: "9",
    gasPrice: "10",
    dataFee: "10",
    spent: "100",
    reserved: "200",
  });
  assert.throws(
    () => reserveSponsorship(store, larger, "d"),
    /sponsor_exhausted/,
  );
  assert.throws(
    () => reserveSponsorship(store, limits, "d"),
    /profile_changed/,
  );
});

test("first-use cohort reservations are atomic, bounded and idempotent across sign-ins and restarts", async () => {
  const { reserveActivationSponsorship } = await import(
    "../services/sponsor-budget.ts"
  );
  const store = memory();
  const gas = { ...limits, cap: 600n };
  const caps = { total: 400n, perAccount: 200n, accounts: 2 };
  const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const results = await Promise.allSettled(
    [1, 2, 3].map(async (n) =>
      reserveActivationSponsorship(store, gas, caps, wallet(n), id(n)),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  const snapshot = JSON.stringify(store.entries("sponsor:"));
  reserveActivationSponsorship(
    { ...store },
    gas,
    caps,
    wallet(1).toUpperCase().replace("0X", "0x"),
    id(1),
  );
  assert.equal(JSON.stringify(store.entries("sponsor:")), snapshot);
  assert.throws(
    () => reserveActivationSponsorship(store, gas, caps, wallet(1), id(9)),
    /account_activation_pending/,
  );
  chargeSponsorship(store, gas, `record_activate:${id(1)}`);
  // Unknown/reverted work and a new id never replenish a slot.
  assert.throws(
    () => reserveActivationSponsorship(store, gas, caps, wallet(3), id(3)),
    /activation_sponsor_exhausted/,
  );
  assert.equal(store.entries("sponsor:reservation:").length, 4);
});

test("a bundle cannot partially reserve when either account or total gas cap is insufficient", async () => {
  const { reserveActivationSponsorship, activationLimits } = await import(
    "../services/sponsor-budget.ts"
  );
  const store = memory(),
    wallet = `0x${"ab".repeat(20)}`,
    id = `0x${"12".repeat(32)}`;
  const caps = { total: 400n, perAccount: 200n, accounts: 2 };
  assert.throws(
    () =>
      reserveActivationSponsorship(
        store,
        { ...limits, cap: 100n },
        caps,
        wallet,
        id,
      ),
    /sponsor_exhausted/,
  );
  assert.deepEqual(store.entries("sponsor:"), []);
  assert.throws(
    () =>
      reserveActivationSponsorship(
        store,
        limits,
        { ...caps, perAccount: 199n },
        wallet,
        id,
      ),
    /account_cap/,
  );
  assert.deepEqual(store.entries("sponsor:"), []);
  assert.throws(() => activationLimits({}), /unconfigured/);
  assert.throws(
    () =>
      activationLimits({
        ACTIVATION_TOTAL_CAP_WEI: "100",
        ACTIVATION_ACCOUNT_CAP_WEI: "200",
        ACTIVATION_MAX_ACCOUNTS: "2",
      }),
    /unconfigured/,
  );
  assert.throws(
    () =>
      activationLimits({
        ACTIVATION_TOTAL_CAP_WEI: "100",
        ACTIVATION_ACCOUNT_CAP_WEI: "100",
        ACTIVATION_MAX_ACCOUNTS: "0",
      }),
    /unconfigured/,
  );
});
