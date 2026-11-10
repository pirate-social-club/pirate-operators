import { bytes32, hashJson, insist } from "../community/common.ts";
import type { RewardChain, RewardPayment, RewardSources } from "./contracts.ts";
import { RewardStore, type PaymentRow } from "./store.ts";
import { rewardAmount, rewardId } from "./validation.ts";
import { RewardTreasury } from "./treasury.ts";
import { paymentGuardNonce } from "./moss-guard.ts";
import { verifyRewardOfferIds } from "./offers.ts";
import { RewardPaymentLifecycle } from "./payment-lifecycle.ts";

interface Inventory {
  received_atomic: string;
  reserved_atomic: string;
  paid_atomic: string;
  cost_atomic: string;
  audit_cursor: string | null;
}
export class RewardPayments {
  readonly store: RewardStore;
  readonly chain: RewardChain;
  readonly now: () => number;
  readonly source?: RewardSources;
  constructor(
    store: RewardStore,
    chain: RewardChain,
    now: () => number = Date.now,
    source?: RewardSources,
  ) {
    this.store = store;
    this.chain = chain;
    this.now = now;
    this.source = source;
  }
  private async inventory() {
    const r = await this.store
      .statement(
        "SELECT * FROM reward_inventory WHERE program_id=?",
        this.store.program,
      )
      .first<Inventory>();
    insist(r, "reward_inventory_missing", 503);
    return r;
  }
  async fund(
    id: string,
    hash: string,
    logIndex: number,
    source: {
      kind: "prefunding" | "conversion";
      sourceUsdcAtomic: string;
      sourceTransactionHash: string | null;
      feeUsdcAtomic: string;
    },
  ) {
    rewardId(id);
    bytes32(hash);
    rewardAmount(source.sourceUsdcAtomic);
    rewardAmount(source.feeUsdcAtomic);
    insist(
      source.kind === "prefunding" || source.kind === "conversion",
      "invalid_reward_funding_kind",
    );
    insist(
      source.kind === "prefunding"
        ? source.sourceUsdcAtomic === "0" &&
            source.feeUsdcAtomic === "0" &&
            source.sourceTransactionHash === null
        : rewardAmount(source.sourceUsdcAtomic) > 0n &&
            rewardAmount(source.feeUsdcAtomic) <=
              rewardAmount(source.sourceUsdcAtomic),
      "invalid_reward_funding_source",
    );
    if (source.kind === "conversion") bytes32(source.sourceTransactionHash);
    const receipt = await this.chain.incoming(
      this.store.profile,
      hash,
      logIndex,
    );
    insist(
      receipt.chainId === 6343 &&
        receipt.token === this.store.profile.token &&
        receipt.recipient === this.store.profile.payoutWallet &&
        receipt.transactionHash === hash &&
        receipt.logIndex === logIndex &&
        receipt.sender !== receipt.recipient,
      "reward_funding_receipt_mismatch",
      409,
    );
    const amount = rewardAmount(receipt.amountAtomic);
    insist(amount > 0n, "reward_funding_zero");
    const inputHash = hashJson({ hash, logIndex, source });
    await this.store.atomic(async () => {
      const prior = await this.store
        .statement(
          "SELECT input_hash FROM reward_funding WHERE funding_id=?",
          id,
        )
        .first<{ input_hash: string }>();
      if (prior) {
        insist(prior.input_hash === inputHash, "reward_funding_conflict", 409);
        return { value: null, statements: [] };
      }
      const inventory = await this.inventory();
      return {
        value: null,
        statements: [
          this.store.statement(
            "INSERT INTO reward_funding(funding_id,program_id,kind,source_json,destination_json,input_hash,amount_atomic,transaction_hash,log_index) VALUES(?,?,?,?,?,?,?,?,?)",
            id,
            this.store.program,
            source.kind,
            JSON.stringify(source),
            JSON.stringify(receipt),
            inputHash,
            amount.toString(),
            hash,
            logIndex,
          ),
          this.store.statement(
            "UPDATE reward_inventory SET received_atomic=?,audit_cursor=? WHERE program_id=?",
            (rewardAmount(inventory.received_atomic) + amount).toString(),
            inventory.audit_cursor === null ||
              rewardAmount(inventory.audit_cursor) >
                rewardAmount(receipt.blockNumber)
              ? receipt.blockNumber
              : inventory.audit_cursor,
            this.store.program,
          ),
        ],
      };
    });
    return receipt;
  }
  async prepare(id: string, accountId: string): Promise<RewardPayment> {
    rewardId(id);
    rewardId(accountId);
    await this.store.init();
    const previous = await this.store
      .statement(
        "SELECT * FROM reward_payments WHERE payment_id=? AND program_id=?",
        id,
        this.store.program,
      )
      .first<PaymentRow>();
    if (previous) {
      insist(previous.account_id === accountId, "reward_payment_conflict", 409);
      return this.store.paymentView(previous);
    }
    const audit = await new RewardTreasury(this.store, this.chain).audit();
    insist(audit.complete, "reward_audit_catching_up", 409);
    insist(audit.unmatched.length === 0, "reward_unmatched_outgoing", 409);
    const balance = rewardAmount(
      await this.chain.balance(
        this.store.profile,
        this.store.profile.payoutWallet,
      ),
    );
    const minimumBlock = (
      rewardAmount(await this.chain.position(this.store.profile)) + 1n
    ).toString();
    const guardNonce = paymentGuardNonce(
      this.store.program,
      this.store.profile.payoutWallet,
      id,
    );
    insist(
      (await this.chain.guard(this.store.profile, guardNonce, minimumBlock)) ===
        null,
      "reward_guard_already_used",
      409,
    );
    await this.store.atomic(async () => {
      const prior = await this.store
        .statement(
          "SELECT * FROM reward_payments WHERE payment_id=? AND program_id=?",
          id,
          this.store.program,
        )
        .first<PaymentRow>();
      if (prior) {
        insist(prior.account_id === accountId, "reward_payment_conflict", 409);
        return { value: null, statements: [] };
      }
      const active = await this.store
        .statement(
          "SELECT payment_id FROM reward_payments WHERE program_id=? AND sender=? AND state IN ('prepared','awaiting_signature','submitted','review_required')",
          this.store.program,
          this.store.profile.payoutWallet,
        )
        .first();
      insist(!active, "reward_payout_account_busy", 409);
      const credits = (
        await this.store
          .statement(
            "SELECT * FROM reward_credits WHERE program_id=? AND account_id=? AND claim_state='accepted' AND payment_id IS NULL AND paid_atomic='0' ORDER BY credit_id LIMIT 51",
            this.store.program,
            accountId,
          )
          .all<import("./store.ts").CreditRow>()
      ).results;
      insist(
        credits.length > 0 && credits.length <= 50,
        "reward_payment_credit_limit",
        409,
      );
      const recipient = credits[0].wallet;
      insist(
        recipient !== this.store.profile.payoutWallet &&
          credits.every((c) => c.wallet === recipient),
        "reward_payout_recipient_conflict",
        409,
      );
      const amount = credits.reduce(
        (sum, c) => sum + rewardAmount(c.amount_atomic),
        0n,
      );
      rewardAmount(amount.toString());
      const inventory = await this.inventory();
      insist(
        rewardAmount(inventory.received_atomic) -
          rewardAmount(inventory.reserved_atomic) -
          rewardAmount(inventory.paid_atomic) -
          rewardAmount(inventory.cost_atomic) >=
          amount && balance >= amount,
        "reward_reserve_not_funded",
        409,
      );
      await verifyRewardOfferIds(
        this.store,
        this.source,
        credits.map((credit) => credit.offer_id),
      );
      return {
        value: null,
        statements: [
          this.store.statement(
            "INSERT INTO reward_payments(payment_id,program_id,account_id,sender,recipient,amount_atomic,state,minimum_block,prepared_at,guard_nonce) VALUES(?,?,?,?,?,?,'prepared',?,?,?)",
            id,
            this.store.program,
            accountId,
            this.store.profile.payoutWallet,
            recipient,
            amount.toString(),
            minimumBlock,
            this.now(),
            guardNonce,
          ),
          ...credits.map((c) =>
            this.store.statement(
              "UPDATE reward_credits SET payment_id=? WHERE program_id=? AND credit_id=? AND payment_id IS NULL",
              id,
              this.store.program,
              c.credit_id,
            ),
          ),
          ...credits.map((c) =>
            this.store.statement(
              "INSERT INTO reward_payment_items(payment_id,credit_id,amount_atomic) VALUES(?,?,?)",
              id,
              c.credit_id,
              c.amount_atomic,
            ),
          ),
          this.store.statement(
            "UPDATE reward_inventory SET reserved_atomic=? WHERE program_id=?",
            (rewardAmount(inventory.reserved_atomic) + amount).toString(),
            this.store.program,
          ),
        ],
      };
    });
    return this.store.paymentView(await this.store.payment(id));
  }
  private lifecycle() {
    return new RewardPaymentLifecycle(
      this.store,
      this.chain,
      this.now,
      this.source,
    );
  }
  dispatch(id: string, action: "pay" | "cancel", attemptId: string) {
    return this.lifecycle().dispatch(id, action, attemptId);
  }
  outcome(
    id: string,
    attemptId: string,
    outcome: "approved" | "cancelled" | "error" | "unknown",
    hash?: string,
  ) {
    return this.lifecycle().outcome(id, attemptId, outcome, hash);
  }
  attach(id: string, hash: string, attemptId: string) {
    return this.outcome(id, attemptId, "approved", hash);
  }
  reconcile(id: string) {
    return this.lifecycle().reconcile(id);
  }
  recover(id: string, hash: string) {
    return this.lifecycle().recover(id, hash);
  }
  async cancelPrepared(id: string) {
    await this.store.atomic(async () => {
      const row = await this.store.payment(rewardId(id));
      insist(
        row.state === "prepared" &&
          row.dispatch_at === null &&
          row.transaction_hash === null,
        "reward_payment_cancellation_needs_reconciliation",
        409,
      );
      const inventory = await this.inventory(),
        amount = rewardAmount(row.amount_atomic);
      insist(
        rewardAmount(inventory.reserved_atomic) >= amount,
        "reward_reservation_corrupt",
        503,
      );
      return {
        value: null,
        statements: [
          this.store.statement(
            "UPDATE reward_payments SET state='cancelled' WHERE payment_id=?",
            id,
          ),
          this.store.statement(
            "UPDATE reward_credits SET payment_id=NULL WHERE program_id=? AND payment_id=?",
            this.store.program,
            id,
          ),
          this.store.statement(
            "UPDATE reward_inventory SET reserved_atomic=? WHERE program_id=?",
            (rewardAmount(inventory.reserved_atomic) - amount).toString(),
            this.store.program,
          ),
        ],
      };
    });
    return this.store.paymentView(await this.store.payment(id));
  }
}
