import { hashJson, insist, token } from "../community/common.ts";
import type {
  RewardsProfile,
  RewardPayment,
  RewardCredit,
  RewardOffer,
} from "./contracts.ts";

export interface CreditRow {
  credit_id: string;
  offer_id: string;
  account_id: string;
  wallet: string;
  amount_atomic: string;
  paid_atomic: string;
  claim_state: RewardCredit["claim"]["status"];
  payment_id: string | null;
  payment_state: RewardPayment["state"] | null;
}
export interface OfferRow {
  offer_id: string;
  drawing_id: string;
  song_key: string;
  cutoff_at: number;
  opens_at: number;
  purchase_hash: string;
  ticket_ids_json: string;
  input_hash: string;
  purchase_evidence: string;
  state: RewardOffer["state"];
  entries_json: string | null;
  winnings_usdc_atomic: string | null;
  payout_atomic: string | null;
  remainder_atomic: string | null;
  settlement_evidence: string | null;
}
export interface PaymentRow {
  payment_id: string;
  account_id: string;
  sender: string;
  recipient: string;
  amount_atomic: string;
  state: RewardPayment["state"];
  transaction_hash: string | null;
  transfer_log_index: number | null;
  minimum_block: string;
  prepared_at: number;
  dispatch_at: number | null;
  guard_nonce: string;
  guard_log_index: number | null;
  latest_attempt_id: string | null;
}
export class RewardStore {
  readonly db: D1Database;
  readonly profile: RewardsProfile;
  constructor(db: D1Database, profile: RewardsProfile) {
    this.db = db;
    this.profile = profile;
  }
  get program() {
    return this.profile.programId;
  }
  statement(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).bind(...values);
  }
  async init() {
    const hash = hashJson(this.profile);
    await this.statement(
      "INSERT INTO reward_programs(program_id,profile_hash) VALUES(?,?) ON CONFLICT DO NOTHING",
      this.program,
      hash,
    ).run();
    const row = await this.statement(
      "SELECT profile_hash FROM reward_programs WHERE program_id=?",
      this.program,
    ).first<{ profile_hash: string }>();
    insist(
      row?.profile_hash === hash,
      "reward_program_configuration_changed",
      503,
    );
    await this.statement(
      "INSERT INTO reward_inventory(program_id) VALUES(?) ON CONFLICT DO NOTHING",
      this.program,
    ).run();
  }
  /** Program revision serializes read/compute/write batches without SQL numeric money casts. */
  async atomic<T>(
    build: () => Promise<{ statements: D1PreparedStatement[]; value: T }>,
  ): Promise<T> {
    await this.init();
    for (let retry = 0; retry < 8; retry++) {
      const row = await this.statement(
        "SELECT revision FROM reward_programs WHERE program_id=?",
        this.program,
      ).first<{ revision: number }>();
      insist(row, "reward_program_missing", 503);
      const { statements, value } = await build();
      const guard = token();
      try {
        await this.db.batch([
          this.statement(
            "UPDATE reward_programs SET revision=revision+1 WHERE program_id=? AND revision=?",
            this.program,
            row.revision,
          ),
          this.statement(
            "INSERT INTO transaction_guards(guard_id,valid) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)",
            guard,
          ),
          ...statements,
          this.statement(
            "DELETE FROM transaction_guards WHERE guard_id=?",
            guard,
          ),
        ]);
        return value;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            error.message.includes("CHECK constraint failed: valid = 1")
          )
        )
          throw error;
      }
    }
    throw new Error("reward_program_contention");
  }
  async offer(id: string): Promise<OfferRow> {
    const row = await this.statement(
      "SELECT * FROM reward_offers WHERE program_id=? AND offer_id=?",
      this.program,
      id,
    ).first<OfferRow>();
    insist(row, "reward_offer_not_found", 404);
    return row;
  }
  async payment(id: string): Promise<PaymentRow> {
    const row = await this.statement(
      "SELECT * FROM reward_payments WHERE program_id=? AND payment_id=?",
      this.program,
      id,
    ).first<PaymentRow>();
    insist(row, "reward_payment_not_found", 404);
    return row;
  }
  async credits(
    account: string,
    cursor = "",
    limit = 100,
  ): Promise<CreditRow[]> {
    const rows = await this.statement(
      `SELECT c.*,p.state AS payment_state FROM reward_credits c
      LEFT JOIN reward_payments p ON p.payment_id=c.payment_id
      WHERE c.program_id=? AND c.account_id=? AND c.credit_id>? ORDER BY c.credit_id LIMIT ?`,
      this.program,
      account,
      cursor,
      limit,
    ).all<CreditRow>();
    return rows.results;
  }
  creditView(row: CreditRow): RewardCredit {
    return {
      credit_id: row.credit_id,
      offer_id: row.offer_id,
      account_id: row.account_id,
      chain_id: 6343,
      token_address: this.profile.token,
      token_decimals: this.profile.decimals,
      amount_atomic: row.amount_atomic,
      paid_atomic: row.paid_atomic,
      claim: {
        status: row.claim_state,
        payout_status:
          row.payment_state === "confirmed"
            ? "confirmed"
            : row.payment_state === "submitted"
              ? "sending"
              : "awaiting_payment",
      },
      payment_id: row.payment_id,
    };
  }
  async paymentView(row: PaymentRow): Promise<RewardPayment> {
    const credits = await this.statement(
      "SELECT credit_id FROM reward_payment_items WHERE payment_id=? ORDER BY credit_id",
      row.payment_id,
    ).all<{ credit_id: string }>();
    const attempts = await this.statement(
      "SELECT attempt_id,action,outcome,transaction_hash,created_at FROM reward_payment_attempts WHERE payment_id=? ORDER BY created_at DESC,attempt_id DESC LIMIT 100",
      row.payment_id,
    ).all<{
      attempt_id: string;
      action: "pay" | "cancel";
      outcome: import("./contracts.ts").RewardPaymentAttempt["outcome"];
      transaction_hash: string | null;
      created_at: number;
    }>();
    return {
      paymentId: row.payment_id,
      accountId: row.account_id,
      sender: row.sender,
      recipient: row.recipient,
      chainId: 6343,
      token: this.profile.token,
      decimals: this.profile.decimals,
      amountAtomic: row.amount_atomic,
      creditIds: credits.results.map((c) => c.credit_id),
      state: row.state,
      transactionHash: row.transaction_hash,
      preparedAt: row.prepared_at,
      guardNonce: row.guard_nonce,
      everDispatched: row.dispatch_at !== null,
      latestAttemptId: row.latest_attempt_id,
      attempts: attempts.results.map((a) => ({
        attemptId: a.attempt_id,
        action: a.action,
        outcome: a.outcome,
        transactionHash: a.transaction_hash,
        createdAt: a.created_at,
      })),
    };
  }
}
