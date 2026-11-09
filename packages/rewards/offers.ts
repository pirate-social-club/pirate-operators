import { bytes32, hashJson, insist, object } from "../community/common.ts";
import {
  assertRehearsalOffer,
  isRetiredRehearsal,
  rehearsalTermsFor,
} from "./rehearsal.ts";
import type {
  QualificationEntry,
  RewardOffer,
  RewardOfferInput,
  RewardSources,
} from "./contracts.ts";
import { RewardStore, type OfferRow } from "./store.ts";
import {
  rewardAddress,
  rewardAmount,
  rewardId,
  rewardTime,
} from "./validation.ts";

/** Raw results read for one offer; repeats collapse per account below. */
const MAX_QUALIFIER_RESULTS = 20000;
/** Accounts entered per offer; settlement writes one credit each in one batch. */
export const MAX_REWARD_ENTRIES = 500;

export function offerView(row: OfferRow): RewardOffer {
  const mode = object(JSON.parse(row.purchase_evidence)).mode;
  insist(
    mode === "simulated" || mode === "live-testnet",
    "reward_purchase_mode_missing",
    503,
  );
  return {
    evidenceMode: mode,
    offerId: row.offer_id,
    drawingId: row.drawing_id,
    songKey: row.song_key,
    opensAt: row.opens_at,
    cutoffAt: row.cutoff_at,
    purchaseHash: row.purchase_hash,
    ticketIds: JSON.parse(row.ticket_ids_json),
    state: row.state,
    entries: row.entries_json === null ? null : JSON.parse(row.entries_json),
    winningsUsdcAtomic: row.winnings_usdc_atomic,
    payoutAtomic: row.payout_atomic,
    remainderAtomic: row.remainder_atomic,
  };
}
export class RewardOffers {
  readonly store: RewardStore;
  readonly source: RewardSources;
  readonly now: () => number;
  constructor(
    store: RewardStore,
    source: RewardSources,
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.source = source;
    this.now = now;
    insist(
      store.profile.mode === source.mode,
      "reward_evidence_mode_mismatch",
      503,
    );
  }
  async attach(input: RewardOfferInput) {
    rewardId(input.offerId);
    rewardAmount(input.drawingId);
    bytes32(input.songKey);
    bytes32(input.purchaseHash);
    rewardTime(input.opensAt);
    rewardTime(input.cutoffAt);
    const prior = await this.store
      .statement(
        "SELECT input_hash FROM reward_offers WHERE program_id=? AND offer_id=?",
        this.store.program,
        input.offerId,
      )
      .first<{ input_hash: string }>();
    if (prior) {
      insist(
        prior.input_hash === hashJson(input),
        "reward_offer_conflict",
        409,
      );
      return offerView(await this.store.offer(input.offerId));
    }
    // A retired rehearsal keeps its original offer and terms; it never reopens.
    insist(
      !isRetiredRehearsal(this.store.profile, input.offerId),
      "reward_rehearsal_retired",
      409,
    );
    insist(
      input.opensAt >= this.now() && input.cutoffAt > input.opensAt,
      "reward_window_invalid",
    );
    insist(
      input.ticketIds.length > 0 &&
        input.ticketIds.length <= 50 &&
        new Set(input.ticketIds).size === input.ticketIds.length,
      "invalid_reward_tickets",
    );
    for (const id of input.ticketIds) rewardAmount(id);
    const evidence = await this.source.purchase(input, this.store.profile);
    bytes32(evidence.receiptHash);
    const expectedMode =
      this.store.profile.rehearsal?.offerId === input.offerId
        ? "simulated"
        : this.store.profile.mode;
    insist(
      evidence.mode === expectedMode,
      "reward_purchase_mode_mismatch",
      503,
    );
    if (this.store.profile.rehearsal?.offerId === input.offerId)
      assertRehearsalOffer(this.store.profile, input);
    return this.store.atomic(async () => {
      const prior = await this.store
        .statement(
          "SELECT input_hash FROM reward_offers WHERE program_id=? AND offer_id=?",
          this.store.program,
          input.offerId,
        )
        .first<{ input_hash: string }>();
      const hash = hashJson(input);
      if (prior) {
        insist(prior.input_hash === hash, "reward_offer_conflict", 409);
        return {
          value: offerView(await this.store.offer(input.offerId)),
          statements: [],
        };
      }
      insist(
        this.now() < input.cutoffAt && this.now() <= input.opensAt,
        "reward_attachment_late",
        409,
      );
      const insert = this.store.statement(
        `INSERT INTO reward_offers(program_id,offer_id,drawing_id,song_key,opens_at,cutoff_at,purchase_hash,ticket_ids_json,input_hash,purchase_evidence,state) VALUES(?,?,?,?,?,?,?,?,?,?,'open')`,
        this.store.program,
        input.offerId,
        input.drawingId,
        input.songKey,
        input.opensAt,
        input.cutoffAt,
        input.purchaseHash,
        JSON.stringify(input.ticketIds),
        hash,
        JSON.stringify(evidence),
      );
      return {
        value: {
          ...input,
          evidenceMode: evidence.mode,
          state: "open" as const,
          entries: null,
          winningsUsdcAtomic: null,
          payoutAtomic: null,
          remainderAtomic: null,
        },
        statements: [
          insert,
          ...input.ticketIds.map((id) =>
            this.store.statement(
              "INSERT INTO reward_tickets(source_ticket_id,program_id,offer_id) VALUES(?,?,?)",
              evidence.mode === "simulated"
                ? `simulated:${this.store.program}:${id}`
                : `84532:${id}`,
              this.store.program,
              input.offerId,
            ),
          ),
        ],
      };
    });
  }
  async close(id: string) {
    const input = offerView(await this.store.offer(rewardId(id)));
    if (input.state !== "open") return input;
    insist(this.now() >= input.cutoffAt, "reward_cutoff_not_reached", 409);
    const candidates = await this.source.qualifiers(input);
    insist(
      candidates.length <= MAX_QUALIFIER_RESULTS,
      "reward_entry_limit",
      409,
    );
    return this.store.atomic(async () => {
      const row = await this.store.offer(id);
      if (row.state !== "open")
        return { value: offerView(row), statements: [] };
      // Repeated results collapse to each account's earliest one before any
      // limit applies, so one account cannot crowd others out.
      const earliest = new Map<string, QualificationEntry>();
      for (const entry of candidates) {
        rewardId(entry.accountId);
        bytes32(entry.evidenceHash);
        rewardTime(entry.completedAt);
        const wallet = rewardAddress(entry.wallet);
        insist(
          entry.completedAt >= row.opens_at &&
            entry.completedAt < row.cutoff_at,
          "reward_evidence_outside_window",
          409,
        );
        const prior = earliest.get(entry.accountId);
        insist(
          !prior || prior.wallet === wallet,
          "reward_qualifier_wallet_changed",
          409,
        );
        if (
          !prior ||
          entry.completedAt < prior.completedAt ||
          (entry.completedAt === prior.completedAt &&
            entry.evidenceHash < prior.evidenceHash)
        )
          earliest.set(entry.accountId, { ...entry, wallet });
      }
      // Anyone with an account may earn; no operator approval exists. Past
      // the entry limit the earliest qualifying accounts enter, so an offer
      // can always close. Each entry's wallet must be that account's MOSS sign-in.
      const sorted = [...earliest.values()]
        .sort(
          (a, b) =>
            a.completedAt - b.completedAt ||
            a.accountId.localeCompare(b.accountId),
        )
        .slice(0, MAX_REWARD_ENTRIES)
        .sort((a, b) => a.accountId.localeCompare(b.accountId));
      for (let i = 0; i < sorted.length; i += 90) {
        const chunk = sorted.slice(i, i + 90);
        const bound = await this.store
          .statement(
            `SELECT account_id,subject FROM credential_bindings WHERE namespace='moss' AND network=6343 AND account_id IN (${chunk.map(() => "?").join(",")})`,
            ...chunk.map((e) => e.accountId),
          )
          .all<{ account_id: string; subject: string }>();
        for (const entry of chunk)
          insist(
            bound.results.some(
              (b) =>
                b.account_id === entry.accountId && b.subject === entry.wallet,
            ),
            "reward_qualifier_wallet_changed",
            409,
          );
      }
      return {
        value: { ...offerView(row), state: "closed" as const, entries: sorted },
        statements: [
          this.store.statement(
            "UPDATE reward_offers SET state='closed',entries_json=? WHERE program_id=? AND offer_id=?",
            JSON.stringify(sorted),
            this.store.program,
            id,
          ),
        ],
      };
    });
  }
  async settle(id: string, claimHash?: string) {
    const input = offerView(await this.store.offer(rewardId(id)));
    // A rehearsal ID that names an offer attached with real evidence would
    // route its settlement to the simulated prize; only that offer is refused.
    insist(
      input.evidenceMode === "simulated" ||
        !rehearsalTermsFor(this.store.profile, input.offerId),
      "reward_rehearsal_offer_conflict",
      409,
    );
    if (
      input.evidenceMode === "simulated" &&
      this.store.profile.mode === "live-testnet"
    ) {
      assertRehearsalOffer(this.store.profile, input);
      insist(
        claimHash === undefined,
        "reward_rehearsal_has_no_collection_transaction",
        409,
      );
    }
    if (input.state === "settled" || input.state === "no_prize") return input;
    insist(input.state !== "open", "reward_entries_not_closed", 409);
    if (claimHash) bytes32(claimHash);
    const observed = await this.source.winnings(
      input,
      this.store.profile,
      claimHash,
    );
    insist(
      observed.mode === input.evidenceMode,
      "reward_settlement_mode_mismatch",
      503,
    );
    const usdc = rewardAmount(observed.usdcAtomic);
    if (
      input.evidenceMode === "simulated" &&
      this.store.profile.mode === "live-testnet"
    ) {
      const terms = assertRehearsalOffer(this.store.profile, input);
      insist(
        claimHash === undefined &&
          observed.usdcAtomic === terms.prizeUsdcAtomic,
        "reward_rehearsal_settlement_changed",
        409,
      );
    }
    if (input.evidenceMode === "live-testnet" && usdc > 0n) {
      bytes32(observed.transactionHash);
      bytes32(observed.blockHash);
      rewardAmount(observed.blockNumber);
    }
    bytes32(observed.receiptHash);
    // Owner direction: preserve the nominal settled dollar amount; treasury covers conversion fees.
    const payout = usdc * 10n ** BigInt(this.store.profile.decimals - 6);
    rewardAmount(payout.toString());
    return this.store.atomic(async () => {
      const row = await this.store.offer(id);
      insist(
        offerView(row).evidenceMode === input.evidenceMode,
        "reward_settlement_mode_mismatch",
        503,
      );
      if (row.state === "settled" || row.state === "no_prize") {
        insist(
          row.winnings_usdc_atomic === usdc.toString(),
          "reward_settlement_changed",
          409,
        );
        return { value: offerView(row), statements: [] };
      }
      insist(
        row.state === "closed" && row.entries_json !== null,
        "reward_entries_not_closed",
        409,
      );
      const entries: QualificationEntry[] = JSON.parse(row.entries_json);
      const share = entries.length ? payout / BigInt(entries.length) : 0n;
      const remainder = payout - share * BigInt(entries.length);
      const state: RewardOffer["state"] = usdc === 0n ? "no_prize" : "settled";
      return {
        value: {
          ...offerView(row),
          state,
          winningsUsdcAtomic: usdc.toString(),
          payoutAtomic: payout.toString(),
          remainderAtomic: remainder.toString(),
        },
        statements: [
          this.store.statement(
            "UPDATE reward_offers SET state=?,winnings_usdc_atomic=?,payout_atomic=?,remainder_atomic=?,settlement_evidence=? WHERE program_id=? AND offer_id=?",
            state,
            usdc.toString(),
            payout.toString(),
            remainder.toString(),
            JSON.stringify(observed),
            this.store.program,
            id,
          ),
          ...(share === 0n
            ? []
            : entries.map((entry) =>
                this.store.statement(
                  "INSERT INTO reward_credits(credit_id,program_id,offer_id,account_id,wallet,amount_atomic) VALUES(?,?,?,?,?,?)",
                  `credit_${hashJson([this.store.program, id, entry.accountId]).slice(2)}`,
                  this.store.program,
                  id,
                  entry.accountId,
                  entry.wallet,
                  share.toString(),
                ),
              )),
        ],
      };
    });
  }
}
