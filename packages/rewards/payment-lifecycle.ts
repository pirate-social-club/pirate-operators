import { bytes32, insist } from "../community/common.ts";
import type {
  RewardChain,
  RewardPayment,
  RewardPaymentAttempt,
  RewardSources,
} from "./contracts.ts";
import { RewardStore, type PaymentRow } from "./store.ts";
import { rewardAmount, rewardId } from "./validation.ts";
import { verifyRewardOfferIds } from "./offers.ts";
import { MOSS_GUARD_IMPLEMENTATION } from "./moss-guard.ts";

const terminal = (row: PaymentRow) =>
  row.state === "confirmed" || row.state === "cancelled";
export class RewardPaymentLifecycle {
  readonly store: RewardStore;
  readonly chain: RewardChain;
  readonly now: () => number;
  readonly source?: RewardSources;
  constructor(
    store: RewardStore,
    chain: RewardChain,
    now: () => number,
    source?: RewardSources,
  ) {
    this.store = store;
    this.chain = chain;
    this.now = now;
    this.source = source;
  }
  async dispatch(
    id: string,
    action: "pay" | "cancel",
    attemptId: string,
  ): Promise<RewardPayment> {
    rewardId(id);
    rewardId(attemptId);
    insist(
      action === "pay" || action === "cancel",
      "invalid_reward_payment_action",
    );
    await this.reconcile(id);
    await this.store.atomic(async () => {
      const row = await this.store.payment(id);
      insist(!terminal(row), "reward_payment_already_resolved", 409);
      const prior = await this.store
        .statement(
          "SELECT payment_id,action FROM reward_payment_attempts WHERE attempt_id=?",
          attemptId,
        )
        .first<{ payment_id: string; action: string }>();
      if (action === "pay") {
        const items = await this.store
          .statement(
            `SELECT c.offer_id FROM reward_payment_items i
           JOIN reward_credits c ON c.credit_id=i.credit_id
           WHERE i.payment_id=? AND c.program_id=? ORDER BY c.offer_id`,
            id,
            this.store.program,
          )
          .all<{ offer_id: string }>();
        insist(items.results.length > 0, "reward_payment_items_missing", 503);
        // Opening or retrying a signing request is a new opportunity to pay.
        // A consumed guard is instead reconciled above from its chain receipt.
        await verifyRewardOfferIds(
          this.store,
          this.source,
          items.results.map((item) => item.offer_id),
        );
      }
      if (prior) {
        insist(
          prior.payment_id === id && prior.action === action,
          "reward_attempt_conflict",
          409,
        );
        return { value: null, statements: [] };
      }
      return {
        value: null,
        statements: [
          this.store.statement(
            "INSERT INTO reward_payment_attempts(attempt_id,payment_id,action,outcome,created_at) VALUES(?,?,?,'opening',?)",
            attemptId,
            id,
            action,
            this.now(),
          ),
          this.store.statement(
            "UPDATE reward_payments SET state='awaiting_signature',dispatch_at=COALESCE(dispatch_at,?),latest_attempt_id=? WHERE payment_id=?",
            this.now(),
            attemptId,
            id,
          ),
        ],
      };
    });
    return this.store.paymentView(await this.store.payment(id));
  }
  async outcome(
    id: string,
    attemptId: string,
    outcome: Exclude<RewardPaymentAttempt["outcome"], "opening">,
    hash?: string,
  ) {
    rewardId(id);
    rewardId(attemptId);
    insist(
      ["approved", "cancelled", "error", "unknown"].includes(outcome),
      "invalid_reward_wallet_outcome",
    );
    if (hash) bytes32(hash);
    insist(outcome !== "approved" || hash, "reward_payment_hash_required", 409);
    await this.store.atomic(async () => {
      const row = await this.store.payment(id),
        attempt = await this.store
          .statement(
            "SELECT outcome,transaction_hash FROM reward_payment_attempts WHERE payment_id=? AND attempt_id=?",
            id,
            attemptId,
          )
          .first<{ outcome: string; transaction_hash: string | null }>();
      insist(attempt, "reward_attempt_not_found", 404);
      insist(
        !attempt.transaction_hash || attempt.transaction_hash === hash,
        "reward_attempt_transaction_conflict",
        409,
      );
      insist(
        attempt.outcome === "opening" ||
          attempt.outcome === "unknown" ||
          attempt.outcome === outcome,
        "reward_attempt_outcome_conflict",
        409,
      );
      return {
        value: null,
        statements: [
          this.store.statement(
            "UPDATE reward_payment_attempts SET outcome=?,transaction_hash=COALESCE(transaction_hash,?) WHERE payment_id=? AND attempt_id=?",
            outcome,
            hash ?? null,
            id,
            attemptId,
          ),
          ...(!terminal(row) && row.latest_attempt_id === attemptId
            ? [
                this.store.statement(
                  "UPDATE reward_payments SET state=? WHERE payment_id=?",
                  outcome === "approved" ? "submitted" : "review_required",
                  id,
                ),
              ]
            : []),
        ],
      };
    });
    return this.reconcile(id);
  }
  async reconcile(id: string) {
    const input = await this.store.payment(rewardId(id));
    if (terminal(input)) return this.store.paymentView(input);
    const proof = await this.chain.guard(
      this.store.profile,
      input.guard_nonce,
      input.minimum_block,
    );
    if (!proof) return this.store.paymentView(input);
    insist(
      proof.chainId === 6343 &&
        proof.account === input.sender &&
        proof.nonce === input.guard_nonce &&
        proof.implementation === MOSS_GUARD_IMPLEMENTATION &&
        rewardAmount(proof.blockNumber) >= rewardAmount(input.minimum_block),
      "reward_guard_receipt_mismatch",
      409,
    );
    bytes32(proof.transactionHash);
    bytes32(proof.blockHash);
    insist(
      Number.isSafeInteger(proof.logIndex) && proof.logIndex >= 0,
      "reward_guard_receipt_mismatch",
      409,
    );
    for (const e of proof.transfers)
      insist(
        e.chainId === 6343 &&
          e.transactionHash === proof.transactionHash &&
          e.blockHash === proof.blockHash &&
          e.blockNumber === proof.blockNumber &&
          e.token === this.store.profile.token,
        "reward_guard_receipt_mismatch",
        409,
      );
    const recipientTransfers = proof.transfers.filter(
      (e) => e.sender === input.sender && e.recipient === input.recipient,
    );
    const transfer = recipientTransfers[0];
    insist(
      recipientTransfers.length === 0 ||
        (recipientTransfers.length === 1 &&
          transfer.amountAtomic === input.amount_atomic &&
          transfer.logIndex > proof.logIndex),
      "reward_payment_receipt_mismatch",
      409,
    );
    const paid = recipientTransfers.length === 1;
    await this.store.atomic(async () => {
      const row = await this.store.payment(id);
      if (terminal(row)) return { value: null, statements: [] };
      insist(row.guard_nonce === proof.nonce, "reward_guard_changed", 409);
      const inventory = await this.store
        .statement(
          "SELECT reserved_atomic,paid_atomic FROM reward_inventory WHERE program_id=?",
          this.store.program,
        )
        .first<{ reserved_atomic: string; paid_atomic: string }>();
      insist(
        inventory &&
          rewardAmount(inventory.reserved_atomic) >=
            rewardAmount(row.amount_atomic),
        "reward_reservation_corrupt",
        503,
      );
      if (paid) {
        const cost = await this.store
          .statement(
            "SELECT cost_id FROM reward_costs WHERE program_id=? AND transaction_hash=? AND log_index=?",
            this.store.program,
            proof.transactionHash,
            transfer.logIndex,
          )
          .first();
        insist(!cost, "reward_payment_event_already_classified", 409);
      }
      return {
        value: null,
        statements: [
          this.store.statement(
            "UPDATE reward_payments SET state=?,transaction_hash=?,guard_log_index=?,transfer_log_index=?,receipt_json=? WHERE payment_id=?",
            paid ? "confirmed" : "cancelled",
            proof.transactionHash,
            proof.logIndex,
            paid ? transfer.logIndex : null,
            JSON.stringify(proof),
            id,
          ),
          paid
            ? this.store.statement(
                "UPDATE reward_credits SET paid_atomic=amount_atomic WHERE program_id=? AND payment_id=?",
                this.store.program,
                id,
              )
            : this.store.statement(
                "UPDATE reward_credits SET payment_id=NULL WHERE program_id=? AND payment_id=?",
                this.store.program,
                id,
              ),
          this.store.statement(
            "UPDATE reward_inventory SET reserved_atomic=?,paid_atomic=? WHERE program_id=?",
            (
              rewardAmount(inventory.reserved_atomic) -
              rewardAmount(row.amount_atomic)
            ).toString(),
            (
              rewardAmount(inventory.paid_atomic) +
              (paid ? rewardAmount(row.amount_atomic) : 0n)
            ).toString(),
            this.store.program,
          ),
        ],
      };
    });
    return this.store.paymentView(await this.store.payment(id));
  }
  async recover(id: string, hash: string) {
    bytes32(hash);
    const row = await this.store.payment(rewardId(id));
    const proof = await this.chain.guard(
      this.store.profile,
      row.guard_nonce,
      row.minimum_block,
    );
    insist(
      proof && proof.transactionHash === hash,
      "reward_recovery_guard_not_confirmed",
      409,
    );
    return this.reconcile(id);
  }
}
