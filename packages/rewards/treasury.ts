import { bytes32, insist } from "../community/common.ts";
import type { ConfirmedTransfer, RewardChain } from "./contracts.ts";
import { RewardStore } from "./store.ts";
import { rewardAmount, rewardId } from "./validation.ts";

/** Read-only on chain. Classifications record operator decisions; they never submit transfers. */
export class RewardTreasury {
  readonly store: RewardStore;
  readonly chain: RewardChain;
  constructor(store: RewardStore, chain: RewardChain) {
    this.store = store;
    this.chain = chain;
  }
  async unmatched() {
    return (
      await this.store
        .statement(
          `SELECT o.transaction_hash,o.log_index,o.receipt_json FROM reward_outgoing o
  LEFT JOIN reward_payments p ON p.program_id=o.program_id AND p.transaction_hash=o.transaction_hash AND p.transfer_log_index=o.log_index AND p.state='confirmed'
  LEFT JOIN reward_costs c ON c.program_id=o.program_id AND c.transaction_hash=o.transaction_hash AND c.log_index=o.log_index
  WHERE o.program_id=? AND p.payment_id IS NULL AND c.cost_id IS NULL ORDER BY o.transaction_hash,o.log_index LIMIT 101`,
          this.store.program,
        )
        .all<{
          transaction_hash: string;
          log_index: number;
          receipt_json: string;
        }>()
    ).results;
  }
  async audit() {
    await this.store.init();
    const inventory = await this.store
      .statement(
        "SELECT audit_cursor FROM reward_inventory WHERE program_id=?",
        this.store.program,
      )
      .first<{ audit_cursor: string | null }>();
    const funding = await this.store
      .statement(
        "SELECT destination_json FROM reward_funding WHERE program_id=? ORDER BY funding_id LIMIT 500",
        this.store.program,
      )
      .all<{ destination_json: string }>();
    if (!funding.results.length)
      return { complete: true, unmatched: await this.unmatched() };
    const earliest = funding.results.reduce(
      (min, row) => {
        const n = rewardAmount(
          (JSON.parse(row.destination_json) as ConfirmedTransfer).blockNumber,
        );
        return min === null || n < min ? n : min;
      },
      null as bigint | null,
    )!;
    const from = inventory?.audit_cursor
        ? rewardAmount(inventory.audit_cursor)
        : earliest,
      head = rewardAmount(
        await this.chain.confirmedPosition(this.store.profile),
      );
    if (from > head)
      return { complete: true, unmatched: await this.unmatched() };
    const to = from + 9999n < head ? from + 9999n : head,
      events = await this.chain.outgoing(
        this.store.profile,
        from.toString(),
        to.toString(),
      );
    insist(events.length <= 100, "reward_audit_event_limit", 409);
    for (const e of events)
      insist(
        e.chainId === 6343 &&
          e.sender === this.store.profile.payoutWallet &&
          e.token === this.store.profile.token &&
          rewardAmount(e.blockNumber) >= from &&
          rewardAmount(e.blockNumber) <= to,
        "reward_audit_event_mismatch",
        503,
      );
    await this.store.atomic(async () => {
      const current = await this.store
        .statement(
          "SELECT audit_cursor FROM reward_inventory WHERE program_id=?",
          this.store.program,
        )
        .first<{ audit_cursor: string | null }>();
      insist(
        current?.audit_cursor === inventory?.audit_cursor,
        "reward_audit_changed",
        409,
      );
      const cursor =
        current?.audit_cursor && rewardAmount(current.audit_cursor) > to + 1n
          ? current.audit_cursor
          : (to + 1n).toString();
      return {
        value: null,
        statements: [
          ...events.map((e) =>
            this.store.statement(
              "INSERT INTO reward_outgoing(program_id,transaction_hash,log_index,receipt_json) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
              this.store.program,
              e.transactionHash,
              e.logIndex,
              JSON.stringify(e),
            ),
          ),
          this.store.statement(
            "UPDATE reward_inventory SET audit_cursor=? WHERE program_id=?",
            cursor,
            this.store.program,
          ),
        ],
      };
    });
    return { complete: to === head, unmatched: await this.unmatched() };
  }
  async cost(id: string, hash: string, index: number) {
    rewardId(id);
    bytes32(hash);
    insist(
      Number.isSafeInteger(index) && index >= 0,
      "invalid_reward_log_index",
    );
    const observed = await this.store
      .statement(
        "SELECT receipt_json FROM reward_outgoing WHERE program_id=? AND transaction_hash=? AND log_index=?",
        this.store.program,
        hash,
        index,
      )
      .first<{ receipt_json: string }>();
    insist(observed, "reward_cost_not_observed", 409);
    const event = JSON.parse(observed.receipt_json) as ConfirmedTransfer;
    insist(
      event.recipient !== this.store.profile.payoutWallet &&
        rewardAmount(event.amountAtomic) > 0n,
      "reward_cost_not_outflow",
      409,
    );
    const verified = await this.chain.transfer(this.store.profile, hash, {
      sender: event.sender,
      recipient: event.recipient,
      amountAtomic: event.amountAtomic,
    });
    insist(
      verified &&
        verified.logIndex === index &&
        verified.blockHash === event.blockHash,
      "reward_cost_receipt_changed",
      409,
    );
    await this.store.atomic(async () => {
      const existing = await this.store
        .statement(
          "SELECT * FROM reward_costs WHERE program_id=? AND transaction_hash=? AND log_index=?",
          this.store.program,
          hash,
          index,
        )
        .first();
      if (existing) return { value: null, statements: [] };
      const payment = await this.store
        .statement(
          "SELECT payment_id FROM reward_payments WHERE program_id=? AND ((transaction_hash=? AND transfer_log_index=?) OR (state IN ('prepared','awaiting_signature','submitted','review_required') AND recipient=? AND amount_atomic=?))",
          this.store.program,
          hash,
          index,
          event.recipient,
          event.amountAtomic,
        )
        .first();
      insist(!payment, "reward_cost_matches_payment", 409);
      const inventory = await this.store
        .statement(
          "SELECT received_atomic,reserved_atomic,paid_atomic,cost_atomic FROM reward_inventory WHERE program_id=?",
          this.store.program,
        )
        .first<{
          received_atomic: string;
          reserved_atomic: string;
          paid_atomic: string;
          cost_atomic: string;
        }>();
      insist(inventory, "reward_inventory_missing", 503);
      const cost = rewardAmount(event.amountAtomic);
      insist(
        cost > 0n &&
          rewardAmount(inventory.received_atomic) -
            rewardAmount(inventory.reserved_atomic) -
            rewardAmount(inventory.paid_atomic) -
            rewardAmount(inventory.cost_atomic) >=
            cost,
        "reward_cost_exceeds_available_inventory",
        409,
      );
      return {
        value: null,
        statements: [
          this.store.statement(
            "INSERT INTO reward_costs(cost_id,program_id,transaction_hash,log_index,amount_atomic,receipt_json) VALUES(?,?,?,?,?,?)",
            id,
            this.store.program,
            hash,
            index,
            cost.toString(),
            JSON.stringify(verified),
          ),
          this.store.statement(
            "UPDATE reward_inventory SET cost_atomic=? WHERE program_id=?",
            (rewardAmount(inventory.cost_atomic) + cost).toString(),
            this.store.program,
          ),
        ],
      };
    });
    return verified;
  }
}
