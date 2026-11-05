import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerializedLegacy,
} from "viem";
import { hashJson, insist, object } from "../../packages/community/common.ts";
import { deploymentJournalProfileHash } from "./deployment-journal.ts";
import type { curatedConfigurationPlan } from "./curated-configuration-plan.ts";

/** A captured intent changes nonce readiness into exact-transaction recovery.
 * It never authorizes allocation of another nonce or a fee replacement. */
export async function curatedConfigurationIntent(
  value: unknown,
  planned: Awaited<ReturnType<typeof curatedConfigurationPlan>>,
) {
  if (value === null) return null;
  const state = object(value),
    txs = object(state.transactions),
    step = "configure_owner_curated";
  insist(
    state.schema === "pirate.testnet-deployment-journal/1" &&
      state.profileHash ===
        deploymentJournalProfileHash(planned.profile, planned.limits) &&
      state.chainId === 6343 &&
      typeof state.signer === "string" &&
      state.signer.toLowerCase() === planned.profile.manifest.controller &&
      Object.keys(txs).every((k) => k === step),
    "curated_configuration_journal_changed",
    409,
  );
  if (!txs[step]) return null;
  const stored = object(txs[step]);
  insist(
    typeof stored.raw === "string" &&
      /^0x[0-9a-f]+$/.test(stored.raw) &&
      stored.raw.length < 32768 &&
      keccak256(stored.raw as Hex) === stored.hash,
    "curated_configuration_signed_intent_changed",
    409,
  );
  const raw = stored.raw as Hex,
    tx = parseTransaction(raw),
    signer = await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerializedLegacy,
    });
  insist(
    tx.type === "legacy" &&
      tx.chainId === 6343 &&
      tx.nonce === planned.profile.transaction.nonce &&
      stored.nonce === tx.nonce &&
      tx.to?.toLowerCase() === planned.call.to &&
      tx.data === planned.call.data &&
      (tx.value ?? 0n) === 0n &&
      tx.gas === planned.call.gas &&
      tx.gasPrice! > 0n &&
      tx.gasPrice! <= planned.limits.maximumGasPrice &&
      tx.gas! * tx.gasPrice! <= planned.limits.maximumTotalFee &&
      stored.maximumFee === (tx.gas! * tx.gasPrice!).toString() &&
      stored.intentHash ===
        hashJson({
          to: planned.call.to,
          data: planned.call.data,
          gas: planned.call.gas.toString(),
        }) &&
      signer.toLowerCase() === planned.profile.manifest.controller,
    "curated_configuration_signed_intent_changed",
    409,
  );
  return { hash: stored.hash as Hex, nonce: tx.nonce };
}
export function curatedConfigurationNonce(
  latest: number,
  pending: number,
  nonce: number,
  retained: boolean,
) {
  insist(
    retained
      ? (latest === nonce && pending >= nonce && pending <= nonce + 1) ||
          (latest === nonce + 1 && pending === latest)
      : latest === nonce && pending === latest,
    "curated_configuration_funding_changed",
    409,
  );
}
export function guardedConfigurationPin(
  deadline: number,
  send: (request: Request) => Promise<Response> = (request) => fetch(request),
  now = () => Date.now(),
) {
  return async (request: Request) => {
    if (new URL(request.url).pathname === "/api/v0/add")
      insist(
        now() < deadline,
        "curated_configuration_pin_deadline_reached",
        409,
      );
    return send(request);
  };
}
