// Conservative lifetime allowance. Unknown and reverted work stays charged.
// A new key or service restart cannot reset this journal's budget.
import { check } from "../packages/protocol/index.ts";
import type { TxStore } from "./operator-tx.ts";

export interface SponsorLimits { cap: bigint; gasPrice: bigint; gas: bigint; dataFee: bigint }
interface Ledger { cap: string; gasPrice: string; gas: string; dataFee: string; spent: string; reserved: string }
interface Reservation { amount: string; state: "reserved" | "charged" | "released" }
export const transactionMaximum = (limits: SponsorLimits) => limits.gas * limits.gasPrice + limits.dataFee;
export function sponsorLimits(env: {
  SPONSOR_CAP_WEI?: string; SPONSOR_GAS_PRICE_WEI?: string; SPONSOR_GAS_LIMIT?: string; SPONSOR_DATA_FEE_WEI?: string;
}): SponsorLimits {
  const values = [env.SPONSOR_CAP_WEI, env.SPONSOR_GAS_PRICE_WEI, env.SPONSOR_GAS_LIMIT, env.SPONSOR_DATA_FEE_WEI];
  check(values.every((x) => typeof x === "string" && /^\d+$/.test(x)), "sponsor_unconfigured");
  const [cap, gasPrice, gas, dataFee] = values.map((x) => BigInt(x!));
  check(cap > 0n && gasPrice > 0n && gas > 0n, "sponsor_unconfigured");
  return { cap, gasPrice, gas, dataFee };
}
function ledger(store: TxStore, limits: SponsorLimits): Ledger {
  const profile = { cap: String(limits.cap), gasPrice: String(limits.gasPrice), gas: String(limits.gas), dataFee: String(limits.dataFee) };
  const old = store.get<Ledger>("sponsor:ledger");
  check(!old || Object.entries(profile).every(([k, v]) => old[k as keyof Ledger] === v), "sponsor_profile_changed");
  return old ?? { ...profile, spent: "0", reserved: "0" };
}
export function reserveSponsorship(store: TxStore, limits: SponsorLimits, reference: string) {
  return store.transaction(() => {
    const current = ledger(store, limits), key = `sponsor:reservation:${reference}`;
    const existing = store.get<Reservation>(key);
    if (existing) { check(existing.state !== "released", "reservation_released"); return existing; }
    const amount = transactionMaximum(limits);
    check(BigInt(current.spent) + BigInt(current.reserved) + amount <= limits.cap, "sponsor_exhausted");
    store.set("sponsor:ledger", { ...current, reserved: String(BigInt(current.reserved) + amount) });
    const reservation: Reservation = { amount: String(amount), state: "reserved" };
    store.set(key, reservation);
    return reservation;
  });
}
export function chargeSponsorship(store: TxStore, limits: SponsorLimits, reference: string) {
  return store.transaction(() => {
    const current = ledger(store, limits), key = `sponsor:reservation:${reference}`;
    const reservation = store.get<Reservation>(key);
    check(reservation && reservation.state !== "released", "reservation_missing");
    if (reservation.state === "charged") return;
    store.set("sponsor:ledger", { ...current,
      spent: String(BigInt(current.spent) + BigInt(reservation.amount)),
      reserved: String(BigInt(current.reserved) - BigInt(reservation.amount)) });
    store.set(key, { ...reservation, state: "charged" });
  });
}
export function releaseSponsorship(store: TxStore, limits: SponsorLimits, reference: string) {
  store.transaction(() => {
    const current = ledger(store, limits), key = `sponsor:reservation:${reference}`;
    const reservation = store.get<Reservation>(key);
    if (!reservation || reservation.state !== "reserved") return;
    store.set("sponsor:ledger", { ...current, reserved: String(BigInt(current.reserved) - BigInt(reservation.amount)) });
    store.set(key, { ...reservation, state: "released" });
  });
}
