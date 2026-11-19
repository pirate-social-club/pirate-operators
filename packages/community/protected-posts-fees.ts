import type { Hex } from "viem";
import { settleBudget } from "./budgets.ts";
import { amount, bytes32, canonical, exact, hashJson, hashText, insist, integer, object } from "./common.ts";
import { preparedOperation, type PreparedOperation } from "./publication.ts";
import type { ExternalOperation, PublicationJob } from "./publication-store.ts";
import { ownerBudgetKey, reserveOwnerBudget, type OwnerBudgetGrant } from "../release/owner-grant.ts";

const provider = "pirate.protected-posts/1";
export const protectedPostsDbClock = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

export interface ProtectedPostsFeeQuote {
  quoteSha256: Hex;
  initiatingLeaseSha256: Hex;
  maximumFeeWei: string;
  expiresAtMs: number;
}

interface FeePorts {
  db: D1Database;
  ownerGrant: OwnerBudgetGrant;
  maximumTotalFee: string;
}

/** The authenticated owner quote binds the ceiling for all sender-debited fees. */
export function prepareProtectedPostsFee(
  ports: FeePorts,
  operation: ExternalOperation,
  job: PublicationJob,
  quote: ProtectedPostsFeeQuote,
): PreparedOperation {
  const checkedQuote = validateQuote(ports, quote);
  insist(Date.now() < checkedQuote.expiresAtMs, "protected_posts_fee_quote_expired", 409);
  requireInitiatingLease(operation, job, checkedQuote);
  return preparation(operation, checkedQuote);
}

function validateQuote(ports: FeePorts, quote: ProtectedPostsFeeQuote): ProtectedPostsFeeQuote {
  const maximumFee = amount(quote.maximumFeeWei);
  insist(
    maximumFee > 0n && maximumFee <= amount(ports.maximumTotalFee) &&
      maximumFee <= amount(ports.ownerGrant.limits.postFeeWei),
    "protected_posts_all_in_fee_exceeds_cap",
    409,
  );
  return {
    quoteSha256: bytes32(quote.quoteSha256),
    initiatingLeaseSha256: bytes32(quote.initiatingLeaseSha256),
    maximumFeeWei: maximumFee.toString(),
    expiresAtMs: integer(quote.expiresAtMs, 1, Number.MAX_SAFE_INTEGER),
  };
}

function preparation(operation: ExternalOperation, quote: ProtectedPostsFeeQuote): PreparedOperation {
  insist(operation.step === "publication" &&
    operation.operation_id === hashJson({ job: operation.job_id, step: "publication" }),
    "protected_posts_fee_original_changed", 409);
  return {
    replay: { kind: "provider_idempotency", provider, key: operation.operation_id },
    payload: {
      requestHash: bytes32(operation.request_hash),
      quoteSha256: quote.quoteSha256,
      maximumFeeWei: quote.maximumFeeWei,
      quoteExpiresAtMs: quote.expiresAtMs,
      initiatingLeaseSha256: quote.initiatingLeaseSha256,
    },
  };
}

export function preparedProtectedPostsFee(ports: FeePorts, operation: ExternalOperation): ProtectedPostsFeeQuote {
  const saved = preparedOperation(operation);
  const quote = object(saved.payload);
  exact(quote, ["requestHash", "quoteSha256", "maximumFeeWei", "quoteExpiresAtMs", "initiatingLeaseSha256"]);
  const checkedQuote = validateQuote(ports, {
    quoteSha256: bytes32(quote.quoteSha256),
    initiatingLeaseSha256: bytes32(quote.initiatingLeaseSha256),
    maximumFeeWei: amount(quote.maximumFeeWei).toString(),
    expiresAtMs: integer(quote.quoteExpiresAtMs, 1, Number.MAX_SAFE_INTEGER),
  });
  insist(operation.prepared_json === canonical(preparation(operation, checkedQuote)),
    "protected_posts_fee_original_changed", 409);
  return checkedQuote;
}

function requireInitiatingLease(operation: ExternalOperation, job: PublicationJob, quote: ProtectedPostsFeeQuote) {
  const lease = job.lease_token;
  insist(job.job_id === operation.job_id && lease && hashText(lease) === quote.initiatingLeaseSha256,
    "protected_posts_fee_authority_changed", 409);
  return lease;
}

export async function reserveProtectedPostsFee(ports: FeePorts, operation: ExternalOperation, job: PublicationJob) {
  const quote = preparedProtectedPostsFee(ports, operation);
  insist(Date.now() < quote.expiresAtMs, "protected_posts_fee_quote_expired", 409);
  const initiatingLease = requireInitiatingLease(operation, job, quote);
  const preparedJson = operation.prepared_json;
  insist(preparedJson, "protected_posts_fee_original_changed", 409);
  const condition = {
    clause: `EXISTS (
      SELECT 1 FROM external_operations e JOIN publication_jobs j ON j.job_id=e.job_id
      WHERE e.operation_id=? AND e.job_id=? AND e.request_hash=? AND e.request_json=? AND e.prepared_json=?
        AND e.step='publication' AND e.status='running' AND e.result_json IS NULL AND e.provider_id IS NULL
        AND j.phase='publication' AND j.lease_token=? AND j.lease_until>${protectedPostsDbClock}
        AND ?>${protectedPostsDbClock}
    )`,
    binds: [operation.operation_id, operation.job_id, operation.request_hash, operation.request_json,
      preparedJson, initiatingLease, quote.expiresAtMs],
    code: "protected_posts_fee_authority_changed",
  };
  const live = await ports.db.withSession("first-primary")
    .prepare(`SELECT 1 AS present WHERE ${condition.clause}`).bind(...condition.binds).first();
  insist(live, condition.code, 409);
  await reserveOwnerBudget(ports.db, ports.ownerGrant, "post_fee_wei", operation.operation_id + ":fee",
    operation.request_hash, quote.maximumFeeWei, undefined, async () => condition);
}

/** Called with the all-in charge from the authenticated canonical receipt for this original. */
export async function settleProtectedPostsFee(ports: FeePorts, operation: ExternalOperation, actualFeeWei: string) {
  const quote = preparedProtectedPostsFee(ports, operation);
  insist(amount(actualFeeWei) <= amount(quote.maximumFeeWei), "protected_posts_actual_fee_exceeds_quote", 409);
  const id = operation.operation_id + ":fee";
  const key = ownerBudgetKey(ports.ownerGrant, "post_fee_wei");
  const condition = {
    clause: `EXISTS (
      SELECT 1 FROM spending_reservations WHERE reservation_id=? AND scope=? AND period=? AND asset=?
        AND request_hash=? AND amount=?
    )`,
    binds: [id, key.scope, key.period, key.asset, operation.request_hash, quote.maximumFeeWei],
    code: "protected_posts_fee_reservation_changed",
  };
  const bound = await ports.db.withSession("first-primary")
    .prepare(`SELECT 1 AS present WHERE ${condition.clause}`).bind(...condition.binds).first();
  insist(bound, condition.code, 409);
  await settleBudget(ports.db, id, [key], actualFeeWei, condition);
}
