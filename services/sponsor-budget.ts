// Conservative lifetime allowance. Unknown and reverted work stays charged.
// A new key or service restart cannot reset this journal's budget.
import { check } from "../packages/protocol/index.ts";
import {
  discardUnallocated,
  intentOf,
  type TxRow,
  type TxStore,
} from "./operator-tx.ts";

export interface SponsorLimits {
  cap: bigint;
  gasPrice: bigint;
  gas: bigint;
  dataFee: bigint;
}
interface Ledger {
  cap: string;
  gasPrice: string;
  gas: string;
  dataFee: string;
  spent: string;
  reserved: string;
}
interface Reservation {
  amount: string;
  state: "reserved" | "charged" | "released";
}
export const transactionMaximum = (limits: SponsorLimits) =>
  limits.gas * limits.gasPrice + limits.dataFee;
export function sponsorLimits(env: {
  SPONSOR_CAP_WEI?: string;
  SPONSOR_GAS_PRICE_WEI?: string;
  SPONSOR_GAS_LIMIT?: string;
  SPONSOR_DATA_FEE_WEI?: string;
}): SponsorLimits {
  const values = [
    env.SPONSOR_CAP_WEI,
    env.SPONSOR_GAS_PRICE_WEI,
    env.SPONSOR_GAS_LIMIT,
    env.SPONSOR_DATA_FEE_WEI,
  ];
  check(
    values.every((x) => typeof x === "string" && /^\d+$/.test(x)),
    "sponsor_unconfigured",
  );
  const [cap, gasPrice, gas, dataFee] = values.map((x) => BigInt(x!));
  check(cap > 0n && gasPrice > 0n && gas > 0n, "sponsor_unconfigured");
  return { cap, gasPrice, gas, dataFee };
}
function ledger(store: TxStore, limits: SponsorLimits): Ledger {
  const profile = {
    cap: String(limits.cap),
    gasPrice: String(limits.gasPrice),
    gas: String(limits.gas),
    dataFee: String(limits.dataFee),
  };
  const old = store.get<Ledger>("sponsor:ledger");
  check(
    !old ||
      Object.entries(profile).every(([k, v]) =>
        k === "cap"
          ? BigInt(old.cap) <= BigInt(v)
          : old[k as keyof Ledger] === v,
      ),
    "sponsor_profile_changed",
  );
  // Raising the configured ceiling is an explicit operator deployment. Keep
  // every charge/reservation; restarts and calendar changes never refill it.
  return old
    ? { ...old, cap: profile.cap }
    : { ...profile, spent: "0", reserved: "0" };
}
export function reserveSponsorship(
  store: TxStore,
  limits: SponsorLimits,
  reference: string,
) {
  return store.transaction(() => {
    const current = ledger(store, limits),
      key = `sponsor:reservation:${reference}`;
    const existing = store.get<Reservation>(key);
    if (existing) {
      check(existing.state !== "released", "reservation_released");
      return existing;
    }
    const amount = transactionMaximum(limits);
    check(
      BigInt(current.spent) + BigInt(current.reserved) + amount <= limits.cap,
      "sponsor_exhausted",
    );
    store.set("sponsor:ledger", {
      ...current,
      reserved: String(BigInt(current.reserved) + amount),
    });
    const reservation: Reservation = {
      amount: String(amount),
      state: "reserved",
    };
    store.set(key, reservation);
    return reservation;
  });
}
export function chargeSponsorship(
  store: TxStore,
  limits: SponsorLimits,
  reference: string,
) {
  return store.transaction(() => {
    const current = ledger(store, limits),
      key = `sponsor:reservation:${reference}`;
    const reservation = store.get<Reservation>(key);
    check(
      reservation && reservation.state !== "released",
      "reservation_missing",
    );
    if (reservation.state === "charged") return;
    store.set("sponsor:ledger", {
      ...current,
      spent: String(BigInt(current.spent) + BigInt(reservation.amount)),
      reserved: String(BigInt(current.reserved) - BigInt(reservation.amount)),
    });
    store.set(key, { ...reservation, state: "charged" });
  });
}
export function releaseSponsorship(
  store: TxStore,
  limits: SponsorLimits,
  reference: string,
) {
  store.transaction(() => {
    const current = ledger(store, limits),
      key = `sponsor:reservation:${reference}`;
    const reservation = store.get<Reservation>(key);
    if (!reservation || reservation.state !== "reserved") return;
    store.set("sponsor:ledger", {
      ...current,
      reserved: String(BigInt(current.reserved) - BigInt(reservation.amount)),
    });
    store.set(key, { ...reservation, state: "released" });
  });
}
/**
 * Returns a reservation, reserved or charged, to the budget. Only for work
 * that provably never received a nonce, so nothing was signed or sent; call
 * it inside the transaction that discards that work's intent.
 */
export function refundUnsent(
  store: TxStore,
  limits: SponsorLimits,
  reference: string,
) {
  const current = ledger(store, limits),
    key = `sponsor:reservation:${reference}`;
  const reservation = store.get<Reservation>(key);
  if (!reservation || reservation.state === "released") return;
  const amount = BigInt(reservation.amount);
  store.set("sponsor:ledger", {
    ...current,
    ...(reservation.state === "charged"
      ? { spent: String(BigInt(current.spent) - amount) }
      : { reserved: String(BigInt(current.reserved) - amount) }),
  });
  store.set(key, { ...reservation, state: "released" });
}

/** Explicit opt-in cohort limits; one durable first-use bundle per account. */
export interface ActivationSponsorEnv {
  ACTIVATION_TOTAL_CAP_WEI?: string;
  ACTIVATION_ACCOUNT_CAP_WEI?: string;
  ACTIVATION_MAX_ACCOUNTS?: string;
}
export interface ActivationLimits {
  total: bigint;
  perAccount: bigint;
  accounts: number;
}
export function activationLimits(env: ActivationSponsorEnv): ActivationLimits {
  const values = [
    env.ACTIVATION_TOTAL_CAP_WEI,
    env.ACTIVATION_ACCOUNT_CAP_WEI,
    env.ACTIVATION_MAX_ACCOUNTS,
  ];
  check(
    values.every((v) => typeof v === "string" && /^[1-9][0-9]{0,77}$/.test(v)),
    "activation_sponsor_unconfigured",
  );
  const [total, perAccount, accounts] = values.map((v) => BigInt(v!));
  check(
    accounts <= BigInt(Number.MAX_SAFE_INTEGER) && perAccount <= total,
    "activation_sponsor_unconfigured",
  );
  return { total, perAccount, accounts: Number(accounts) };
}
interface ActivationLedger {
  total: string;
  perAccount: string;
  accounts: number;
  usedAccounts: number;
  committed: string;
}
/**
 * Called after signature/delegate/nonce verification. Reserve the entire
 * first-use bundle before signing either transaction. All charges survive
 * reverts and unknown outcomes. Same digest retries, a new digest cannot
 * purchase another activation. The journal is community-local, not key-local.
 */
export function reserveActivationSponsorship(
  store: TxStore,
  sponsor: SponsorLimits,
  limits: ActivationLimits,
  learner: string,
  authorizationId: string,
) {
  check(
    /^0x[0-9a-f]{40}$/i.test(learner) && !/^0x0+$/i.test(learner),
    "invalid_wallet",
  );
  check(/^0x[0-9a-f]{64}$/i.test(authorizationId), "invalid_authorization");
  return store.transaction(() => {
    check(!authorizationRetired(store, authorizationId), "stale_sign_in");
    const key = `sponsor:activation:account:${learner.toLowerCase()}`;
    const previous = store.get<{ id: string; amount: string }>(key);
    if (previous) {
      check(previous.id === authorizationId, "account_activation_pending");
      return previous;
    }
    const old = store.get<ActivationLedger>("sponsor:activation:ledger");
    check(
      !old ||
        (limits.total >= BigInt(old.total) &&
          limits.perAccount >= BigInt(old.perAccount) &&
          limits.accounts >= old.accounts),
      "activation_profile_changed",
    );
    const amount = transactionMaximum(sponsor) * 2n;
    check(amount <= limits.perAccount, "activation_account_cap_exceeded");
    check(
      (old?.usedAccounts ?? 0) < limits.accounts &&
        BigInt(old?.committed ?? 0) + amount <= limits.total,
      "activation_sponsor_exhausted",
    );
    // Nested transactions use the existing synchronous TxStore contract.
    // An outer failure rolls back both the cohort slot and general gas budget.
    reserveSponsorship(store, sponsor, `record_activate:${authorizationId}`);
    reserveSponsorship(store, sponsor, `record_authorize:${authorizationId}`);
    const reservation = { id: authorizationId, amount: String(amount) };
    store.set(key, reservation);
    store.set("sponsor:activation:ledger", {
      total: String(limits.total),
      perAccount: String(limits.perAccount),
      accounts: limits.accounts,
      usedAccounts: (old?.usedAccounts ?? 0) + 1,
      committed: String(BigInt(old?.committed ?? 0) + amount),
    } satisfies ActivationLedger);
    return reservation;
  });
}

const retiredKey = (id: string) => `sponsor:authorization:retired:${id}`;
export const authorizationRetired = (store: TxStore, id: string) =>
  store.get(retiredKey(id)) !== undefined;

/** Expiry is checked by the authorization service. An allocation, even without
 * signed bytes, is uncertain and never refundable here. Orphan rows also veto
 * refunds. Retire unsent intents and refund their reservations atomically;
 * release cohort capacity only if the entire first-use bundle was never allocated.
 */
export function retireUnallocatedAuthorization(
  store: TxStore,
  limits: SponsorLimits,
  learner: string,
  id: string,
) {
  return store.transaction(() => {
    const kinds = ["record_activate", "record_authorize"] as const;
    const rows = store.entries("tx:").map(({ value }) => value as TxRow);
    const unsent = kinds.map((kind) => {
      const intent = intentOf(store, kind, id);
      const reservation = store.get<Reservation>(
        `sponsor:reservation:${kind}:${id}`,
      );
      // A charge without its intent is inconsistent evidence, not proof that
      // allocation never happened. Retain it just like an orphan signed row.
      return (
        intent?.nonce == null &&
        !rows.some((row) => row.kind === kind && row.ref === id) &&
        (!reservation ||
          reservation.state === "reserved" ||
          reservation.state === "released" ||
          (reservation.state === "charged" && !!intent))
      );
    });
    // Tombstone also fences callers that were awaiting an RPC before retirement.
    store.set(retiredKey(id), { reason: "stale_sign_in" });
    for (const [index, kind] of kinds.entries())
      if (unsent[index]) {
        check(
          discardUnallocated(store, kind, id),
          "authorization_retirement_changed",
        );
        refundUnsent(store, limits, `${kind}:${id}`);
      }
    const key = `sponsor:activation:account:${learner.toLowerCase()}`;
    const slot = store.get<{ id: string; amount: string }>(key);
    if (slot?.id === id && unsent.every(Boolean)) {
      const ledger = store.get<ActivationLedger>("sponsor:activation:ledger");
      check(
        ledger &&
          ledger.usedAccounts > 0 &&
          BigInt(ledger.committed) >= BigInt(slot.amount),
        "activation_ledger_inconsistent",
      );
      store.set("sponsor:activation:ledger", {
        ...ledger,
        usedAccounts: ledger.usedAccounts - 1,
        committed: String(BigInt(ledger.committed) - BigInt(slot.amount)),
      });
      store.delete(key);
    }
    return unsent.every(Boolean);
  });
}
