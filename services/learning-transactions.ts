import type { Address, Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  dispatch,
  enqueue,
  intentOf,
  type TxKind,
  type TxStore,
} from "./operator-tx.ts";
import {
  chargeSponsorship,
  reserveSponsorship,
  sponsorLimits,
} from "./sponsor-budget.ts";
import { resultsTarget } from "./learning-contract.ts";
import type { Env, Store } from "./runtime.ts";

export type ResultStore = TxStore & Pick<Store, "now">;
export async function submitResultTransaction(
  env: Env,
  store: ResultStore,
  kind: TxKind,
  ref: string,
  data: Hex,
  destination: Address = resultsTarget(env).contract,
  authorizationList?: Parameters<typeof enqueue>[6],
) {
  const previous = intentOf(store, kind, ref);
  check(
    !previous ||
      (previous.to.toLowerCase() === destination.toLowerCase() &&
        previous.data === data),
    "result_transaction_changed",
  );
  const limits = sponsorLimits(env);
  reserveSponsorship(store, limits, `${kind}:${ref}`);
  enqueue(store, kind, ref, destination, data, limits.gas, authorizationList);
  // Preserve conservative charges and original signed bytes across upgrades.
  chargeSponsorship(store, limits, `${kind}:${ref}`);
  return dispatch(env, store, kind, ref, {
    maxFeePerGas: limits.gasPrice,
    maxTotalFee: limits.cap,
  });
}
