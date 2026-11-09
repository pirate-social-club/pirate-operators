import { RewardStore, type PaymentRow } from "../packages/rewards/store.ts";
import { RewardPayments } from "../packages/rewards/payments.ts";
import { RewardClaims } from "../packages/rewards/claims.ts";
import { rewardVeryProvider } from "../packages/rewards/very-provider.ts";
import { rewardChain } from "../packages/rewards/chain.ts";
import { RewardTreasury } from "../packages/rewards/treasury.ts";
import { insist } from "../packages/community/common.ts";
import type {
  RewardChain,
  RewardsProfile,
} from "../packages/rewards/contracts.ts";

/** Resolve at most ten payment nonce guards, even after a lost callback. Never submit or retry. */
export async function reconcileRewardPayments(
  db: D1Database,
  profile: RewardsProfile,
  chain: RewardChain = rewardChain(),
  now: () => number = Date.now,
) {
  const store = new RewardStore(db, profile);
  await store.init();
  await new RewardClaims(store, rewardVeryProvider(), now).expire();
  const rows = await store
    .statement(
      "SELECT * FROM reward_payments WHERE program_id=? AND state IN ('awaiting_signature','submitted','review_required') ORDER BY prepared_at,payment_id LIMIT 10",
      store.program,
    )
    .all<PaymentRow>();
  const payments = new RewardPayments(store, chain, now),
    failures: unknown[] = [];
  for (const row of rows.results) {
    try {
      await payments.reconcile(row.payment_id);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    const audit = await new RewardTreasury(store, chain).audit();
    insist(audit.unmatched.length === 0, "reward_unmatched_outgoing", 409);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "reward_payment_reconciliation_failed");
}
