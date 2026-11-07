import { bytes32, hashJson, insist } from "../community/common.ts";
import type { RewardChain, RewardPayment } from "./contracts.ts";
import { RewardStore, type PaymentRow } from "./store.ts";
import { rewardAmount, rewardId } from "./validation.ts";
import { RewardTreasury } from "./treasury.ts";

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
  constructor(
    store: RewardStore,
    chain: RewardChain,
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.chain = chain;
    this.now = now;
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
      return {
        value: null,
        statements: [
          this.store.statement(
            "INSERT INTO reward_payments(payment_id,program_id,account_id,sender,recipient,amount_atomic,state,minimum_block,prepared_at) VALUES(?,?,?,?,?,?,'prepared',?,?)",
            id,
            this.store.program,
            accountId,
            this.store.profile.payoutWallet,
            recipient,
            amount.toString(),
            minimumBlock,
            this.now(),
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
  async dispatch(id: string) {
    await this.store.atomic(async () => {
      const row = await this.store.payment(rewardId(id));
      insist(
        row.state === "prepared",
        "reward_payment_already_dispatched",
        409,
      );
      return {
        value: null,
        statements: [
          this.store.statement(
            "UPDATE reward_payments SET state='awaiting_signature',dispatch_at=? WHERE payment_id=?",
            this.now(),
            id,
          ),
        ],
      };
    });
    return this.store.paymentView(await this.store.payment(id));
  }
  async attach(id: string, hash: string) {
    bytes32(hash);
    await this.store.atomic(async () => {
      const row = await this.store.payment(rewardId(id));
      insist(
        [
          "awaiting_signature",
          "submitted",
          "review_required",
          "confirmed",
        ].includes(row.state),
        "reward_payment_not_dispatched",
        409,
      );
      if (row.transaction_hash) {
        insist(
          row.transaction_hash === hash,
          "reward_payment_transaction_conflict",
          409,
        );
        return { value: null, statements: [] };
      }
      return {
        value: null,
        statements: [
          this.store.statement(
            "UPDATE reward_payments SET state='submitted',transaction_hash=? WHERE payment_id=?",
            hash,
            id,
          ),
        ],
      };
    });
    return this.store.paymentView(await this.store.payment(id));
  }
  async reconcile(id: string) {
    const input = await this.store.payment(rewardId(id));
    if (input.state === "confirmed") return this.store.paymentView(input);
    insist(input.transaction_hash, "reward_payment_hash_required", 409);
    const receipt = await this.chain.transfer(
      this.store.profile,
      input.transaction_hash,
      {
        sender: input.sender,
        recipient: input.recipient,
        amountAtomic: input.amount_atomic,
      },
    );
    if (!receipt) return this.store.paymentView(input);
    // `sender` is the token Transfer event's from; a MOSS relay may be tx.from.
    insist(
      receipt.chainId === 6343 &&
        receipt.transactionHash === input.transaction_hash &&
        receipt.sender === input.sender &&
        receipt.recipient === input.recipient &&
        receipt.token === this.store.profile.token &&
        receipt.amountAtomic === input.amount_atomic &&
        rewardAmount(receipt.blockNumber) >= rewardAmount(input.minimum_block),
      "reward_payment_receipt_mismatch",
      409,
    );
    await this.store.atomic(async () => {
      const row = await this.store.payment(id);
      if (row.state === "confirmed") return { value: null, statements: [] };
      insist(
        row.transaction_hash === receipt.transactionHash,
        "reward_payment_transaction_conflict",
        409,
      );
      const inventory = await this.inventory(),
        amount = rewardAmount(row.amount_atomic);
      const cost = await this.store
        .statement(
          "SELECT cost_id FROM reward_costs WHERE program_id=? AND transaction_hash=? AND log_index=?",
          this.store.program,
          receipt.transactionHash,
          receipt.logIndex,
        )
        .first();
      insist(!cost, "reward_payment_event_already_classified", 409);
      insist(
        rewardAmount(inventory.reserved_atomic) >= amount,
        "reward_reservation_corrupt",
        503,
      );
      return {
        value: null,
        statements: [
          this.store.statement(
            "UPDATE reward_payments SET state='confirmed',transfer_log_index=?,receipt_json=? WHERE payment_id=?",
            receipt.logIndex,
            JSON.stringify(receipt),
            id,
          ),
          this.store.statement(
            "UPDATE reward_credits SET paid_atomic=amount_atomic WHERE program_id=? AND payment_id=?",
            this.store.program,
            id,
          ),
          this.store.statement(
            "UPDATE reward_inventory SET reserved_atomic=?,paid_atomic=? WHERE program_id=?",
            (rewardAmount(inventory.reserved_atomic) - amount).toString(),
            (rewardAmount(inventory.paid_atomic) + amount).toString(),
            this.store.program,
          ),
        ],
      };
    });
    return this.store.paymentView(await this.store.payment(id));
  }
  /** A manually recovered hash is checked before it can become an immutable payment reference. */
  async recover(id: string, hash: string) {
    bytes32(hash);
    const row = await this.store.payment(rewardId(id));
    insist(
      row.dispatch_at !== null && row.state !== "cancelled",
      "reward_payment_not_dispatched",
      409,
    );
    if (row.transaction_hash) {
      insist(
        row.transaction_hash === hash,
        "reward_payment_transaction_conflict",
        409,
      );
      return this.reconcile(id);
    }
    const event = await this.chain.transfer(this.store.profile, hash, {
      sender: row.sender,
      recipient: row.recipient,
      amountAtomic: row.amount_atomic,
    });
    insist(
      event &&
        event.chainId === 6343 &&
        event.transactionHash === hash &&
        event.sender === row.sender &&
        event.recipient === row.recipient &&
        event.amountAtomic === row.amount_atomic &&
        event.token === this.store.profile.token &&
        rewardAmount(event.blockNumber) >= rewardAmount(row.minimum_block),
      "reward_recovery_transfer_not_confirmed",
      409,
    );
    await this.attach(id, hash);
    return this.reconcile(id);
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
