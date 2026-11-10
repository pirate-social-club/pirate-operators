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
import {
  checkRewardClosureEvidence,
  requiresRewardClosure,
  verifyRewardClosure,
  type RewardClosureSnapshot,
} from "./closure.ts";
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

/** Pinned at attachment; at most this many sources per offer. */
export const MAX_OFFER_RESULT_SOURCES = 8;

export function offerView(row: OfferRow): RewardOffer {
  const evidence = object(JSON.parse(row.purchase_evidence)),
    mode = evidence.mode;
  insist(
    mode === "simulated" || mode === "live-testnet",
    "reward_purchase_mode_missing",
    503,
  );
  // The accepted sources are stored beside the attachment evidence and are
  // covered by the offer's input hash, which close re-checks.
  const sources = evidence.resultSources;
  insist(
    sources === undefined ||
      (Array.isArray(sources) && sources.every((x) => typeof x === "string")),
    "reward_offer_sources_invalid",
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
    ...(sources === undefined ? {} : { resultSources: sources as string[] }),
    state: row.state,
    entries: row.entries_json === null ? null : JSON.parse(row.entries_json),
    winningsUsdcAtomic: row.winnings_usdc_atomic,
    payoutAtomic: row.payout_atomic,
    remainderAtomic: row.remainder_atomic,
  };
}
/** Exactly the attached input, so its hash can be compared with the stored one. */
export function offerInput(offer: RewardOfferInput): RewardOfferInput {
  return {
    offerId: offer.offerId,
    drawingId: offer.drawingId,
    songKey: offer.songKey,
    cutoffAt: offer.cutoffAt,
    purchaseHash: offer.purchaseHash,
    ticketIds: offer.ticketIds,
    opensAt: offer.opensAt,
    ...(offer.resultSources === undefined
      ? {}
      : { resultSources: offer.resultSources }),
  };
}
export async function verifyStoredRewardClosure(
  store: RewardStore,
  source: RewardSources | undefined,
  row: OfferRow,
) {
  if (requiresRewardClosure(row))
    await verifyRewardClosure(store, source, row, offerInput(offerView(row)));
}

export async function verifyRewardOfferIds(
  store: RewardStore,
  source: RewardSources | undefined,
  offerIds: Iterable<string>,
) {
  const ids = [...new Set(offerIds)];
  if (ids.length === 0) return;
  insist(ids.length <= 50, "reward_payment_credit_limit", 409);
  const rows = await store
    .statement(
      `SELECT * FROM reward_offers WHERE program_id=? AND offer_id IN (${ids.map(() => "?").join(",")}) ORDER BY offer_id`,
      store.program,
      ...ids,
    )
    .all<OfferRow>();
  insist(rows.results.length === ids.length, "reward_offer_not_found", 503);
  for (const row of rows.results)
    await verifyStoredRewardClosure(store, source, row);
}

/**
 * A new offer fixes the result sources it accepts at attachment, before its
 * window opens: the operator's choice, or every live source when none is
 * named. A chosen set must include the source the community publishes to now.
 */
function offerSources(
  sources: RewardSources["resultSources"],
  pinned: string[] | undefined,
): string[] | undefined {
  if (!sources) {
    insist(pinned === undefined, "reward_offer_sources_unavailable", 409);
    return undefined;
  }
  const chosen = pinned ?? [...(sources.defaults ?? sources.accepted)];
  insist(
    Array.isArray(chosen) &&
      chosen.length > 0 &&
      chosen.length <= MAX_OFFER_RESULT_SOURCES &&
      new Set(chosen).size === chosen.length &&
      chosen.every((x) => sources.accepted.includes(bytes32(x))) &&
      chosen.includes(sources.current),
    "reward_offer_sources_invalid",
    409,
  );
  return chosen;
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
  async attach(raw: RewardOfferInput) {
    let input = offerInput(raw);
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
      // Resubmitting without pins matches an offer whose pins were defaulted.
      const live = this.source.resultSources;
      insist(
        prior.input_hash === hashJson(input) ||
          (input.resultSources === undefined &&
            !!live &&
            prior.input_hash ===
              hashJson({
                ...input,
                resultSources: [...(live.defaults ?? live.accepted)],
              })),
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
    const resultSources = offerSources(
      this.source.resultSources,
      input.resultSources,
    );
    input = offerInput({ ...input, resultSources });
    insist(
      input.ticketIds.length > 0 &&
        input.ticketIds.length <= 50 &&
        new Set(input.ticketIds).size === input.ticketIds.length,
      "invalid_reward_tickets",
    );
    for (const id of input.ticketIds) rewardAmount(id);
    const closureVersion = this.source.closure?.requires(input) ? 1 : undefined;
    if (closureVersion === 1) await this.source.closure?.admit?.(input);
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
        JSON.stringify({
          ...evidence,
          ...(input.resultSources === undefined
            ? {}
            : { resultSources: input.resultSources }),
          ...(closureVersion === undefined ? {} : { closureVersion }),
        }),
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
    const stored = await this.store.offer(rewardId(id)),
      input = offerView(stored);
    if (input.state !== "open") return input;
    insist(this.now() >= input.cutoffAt, "reward_cutoff_not_reached", 409);
    // The sources read are exactly those pinned when the offer was attached.
    insist(
      hashJson(offerInput(input)) === stored.input_hash,
      "reward_offer_input_changed",
      503,
    );
    const closure = this.source.closure;
    const required = requiresRewardClosure(stored);
    insist(!required || closure, "reward_closure_unavailable", 503);
    const scanned = required
      ? await closure!.scan(offerInput(input), stored.input_hash)
      : null;
    if (scanned)
      checkRewardClosureEvidence(offerInput(input), scanned.evidence);
    const candidates =
      scanned?.entries ?? (await this.source.qualifiers(input));
    insist(
      candidates.length <= MAX_QUALIFIER_RESULTS,
      "reward_entry_limit",
      409,
    );
    return this.store.atomic(async () => {
      const row = await this.store.offer(id);
      if (row.state !== "open")
        return { value: offerView(row), statements: [] };
      insist(
        row.input_hash === stored.input_hash &&
          row.purchase_evidence === stored.purchase_evidence,
        "reward_offer_input_changed",
        503,
      );
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
      const currentBindings = sorted.filter(
        (entry) => !scanned?.captured.has(hashJson(entry)),
      );
      for (let i = 0; i < currentBindings.length; i += 90) {
        const chunk = currentBindings.slice(i, i + 90);
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
      const snapshot: RewardClosureSnapshot | null = scanned && {
        schema: "pirate.reward-closure/1",
        programId: this.store.program,
        inputHash: row.input_hash,
        entriesHash: hashJson(sorted),
        evidence: scanned.evidence,
      };
      if (snapshot) await closure!.verify(offerInput(input), snapshot.evidence);
      return {
        value: { ...offerView(row), state: "closed" as const, entries: sorted },
        statements: [
          this.store.statement(
            "UPDATE reward_offers SET state='closed',entries_json=? WHERE program_id=? AND offer_id=?",
            JSON.stringify(sorted),
            this.store.program,
            id,
          ),
          ...(snapshot
            ? [
                this.store.statement(
                  "INSERT INTO reward_closure_snapshots(program_id,offer_id,snapshot_json,snapshot_hash) VALUES(?,?,?,?)",
                  this.store.program,
                  id,
                  JSON.stringify(snapshot),
                  hashJson(snapshot),
                ),
              ]
            : []),
        ],
      };
    });
  }
  async settle(id: string, claimHash?: string) {
    const stored = await this.store.offer(rewardId(id));
    const input = offerView(stored);
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
    await verifyStoredRewardClosure(this.store, this.source, stored);
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
      await verifyStoredRewardClosure(this.store, this.source, row);
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
