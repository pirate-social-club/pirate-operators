import type { Address, Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  discardUnallocated,
  dispatch,
  enqueue,
  intentOf,
  type SendGate,
  type TxKind,
  type TxStore,
} from "./operator-tx.ts";
import {
  chargeSponsorship,
  refundUnsent,
  reserveSponsorship,
  sponsorLimits,
} from "./sponsor-budget.ts";
import {
  legacyResultsWithdrawn,
  legacyResultsWithheld,
  resultsTarget,
} from "./learning-contract.ts";
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
  return dispatch(
    env,
    store,
    kind,
    ref,
    { maxFeePerGas: limits.gasPrice, maxTotalFee: limits.cap },
    legacyResultGate(env, store),
  );
}
/**
 * Whether a result transaction is still unsent: queued or not, it has no
 * nonce, so nothing was signed. A dispatch that failed before allocating
 * leaves exactly this state, and the result's checks must still run.
 */
export const resultUnsent = (store: TxStore, kind: TxKind, ref: string) =>
  intentOf(store, kind, ref)?.nonce == null;
/**
 * Withdraws a result transaction that never received a nonce, so no path can
 * ever dispatch it, and refunds its sponsorship, since nothing was signed or
 * sent. Returns false, changing nothing, once a nonce is allocated.
 */
export function withdrawUnsentResult(
  env: Env,
  store: ResultStore,
  kind: TxKind,
  ref: string,
) {
  const limits = sponsorLimits(env);
  return store.transaction(() => {
    const queued = intentOf(store, kind, ref) !== undefined;
    if (!discardUnallocated(store, kind, ref)) return false;
    if (queued) refundUnsent(store, limits, `${kind}:${ref}`);
    return true;
  });
}

/**
 * The learner of a first-revision result bound to an earlier version than V4
 * (a V3 Study lesson, or a V2 or V3 Karaoke run), or undefined for any other
 * work. Corrections and V4 results are not covered. Missing records throw,
 * so nothing is sent on a journal that cannot be read.
 */
function legacyResultLearner(
  store: ResultStore,
  kind: TxKind,
  ref: string,
): Address | undefined {
  if (kind !== "record_result") return undefined;
  const study = /^study:(.+):(\d+)$/.exec(ref);
  if (study) {
    if (study[2] !== "1") return undefined;
    const job = store.get<{
      target: { version: number };
      result: { learner: Address };
    }>("studyPublication:" + study[1]);
    check(job, "study_publication_changed");
    return job.target.version === 4 ? undefined : job.result.learner;
  }
  const karaoke = /^(.+):(\d+)$/.exec(ref);
  check(karaoke, "unsupported_result_reference");
  if (karaoke[2] !== "1") return undefined;
  if (store.get(`ticketAuthorization:${karaoke[1]}`) !== undefined)
    return undefined;
  const ticket = store.get<{ body: { participant: Address } }>(
    `ticket:${karaoke[1]}`,
  );
  check(ticket, "ticket_not_found");
  return ticket.body.participant;
}
/**
 * The withdrawal gate on every send of an earlier-version result: the
 * operator's record of the learner's V4 Revocation, or a withdrawal read from
 * the V4 contract (see legacyResultsWithdrawn).
 */
export function legacyResultGate(env: Env, store: ResultStore): SendGate {
  return {
    reason: "authorization_withdrawn",
    recorded(kind, ref) {
      const learner = legacyResultLearner(store, kind, ref);
      return !!learner && legacyResultsWithheld(store, learner);
    },
    async withheld(kind, ref) {
      const learner = legacyResultLearner(store, kind, ref);
      return !!learner && (await legacyResultsWithdrawn(env, store, learner));
    },
    limits() {
      try {
        const limits = sponsorLimits(env);
        return { maxFeePerGas: limits.gasPrice, maxTotalFee: limits.cap };
      } catch {
        return undefined;
      }
    },
  };
}
