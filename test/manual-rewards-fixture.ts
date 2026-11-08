import { readFile } from "node:fs/promises";
import { communityRuntime } from "./community-runtime.ts";
import { hashJson } from "../packages/community/common.ts";
import type {
  ConfirmedTransfer,
  QualificationEntry,
  RewardChain,
  RewardGuardEvidence,
  RewardPayment,
  RewardSources,
  RewardVerificationProvider,
  RewardsProfile,
} from "../packages/rewards/contracts.ts";
import { RewardStore } from "../packages/rewards/store.ts";
import { RewardOffers } from "../packages/rewards/offers.ts";
import { RewardClaims } from "../packages/rewards/claims.ts";
import { RewardPayments } from "../packages/rewards/payments.ts";
import { MOSS_GUARD_IMPLEMENTATION } from "../packages/rewards/moss-guard.ts";

export const rewardTestProfile: RewardsProfile = {
  schema: "pirate.manual-rewards/1",
  programId: `0x${"ab".repeat(32)}`,
  mode: "simulated",
  chainId: 6343,
  token: `0x${"11".repeat(20)}`,
  decimals: 6,
  operatorWallet: `0x${"22".repeat(20)}`,
  payoutWallet: `0x${"33".repeat(20)}`,
  ticketWallet: `0x${"44".repeat(20)}`,
  veryAppId: "fixture-only",
  rpcUrl: "https://invalid.example",
  resultSourceHash: `0x${"88".repeat(32)}`,
};
export const rewardHash = (n: number) =>
  `0x${n.toString(16).padStart(64, "0")}`;
export async function manualRewardsFixture() {
  const runtime = await communityRuntime();
  try {
    const sql = await readFile(
      new URL(
        "../apps/community-wizard/infra/migrations/0011_manual_rewards.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await runtime.db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => runtime.db.prepare(s)),
    );
    const principals = [
      { accountId: "learner_01", wallet: `0x${"55".repeat(20)}` },
      { accountId: "learner_02", wallet: `0x${"66".repeat(20)}` },
      { accountId: "operator_01", wallet: rewardTestProfile.operatorWallet },
    ];
    for (const [i, p] of principals.entries())
      await runtime.db.batch([
        runtime.db
          .prepare(
            "INSERT INTO community_accounts(account_id,author_id,created_at) VALUES(?,?,0)",
          )
          .bind(p.accountId, rewardHash(i + 100)),
        runtime.db
          .prepare(
            "INSERT INTO credential_bindings(binding_id,account_id,namespace,network,subject,created_at) VALUES(?,?,'moss',6343,?,0)",
          )
          .bind(`binding_${i}`, p.accountId, p.wallet),
      ]);
    let now = 1794070800000,
      prize = "1110000",
      balance = "10000000",
      position = "100";
    const subjects = new Map<string, string | null>(),
      transfers = new Map<string, ConfirmedTransfer>(),
      guards = new Map<string, RewardGuardEvidence>();
    let openings = 0;
    let candidates: QualificationEntry[] = [];
    const chain: RewardChain = {
      guard: async (_p, nonce) => guards.get(nonce) ?? null,
      outgoing: async (_p, from, to) =>
        [...transfers.values()].filter(
          (t) =>
            t.sender === rewardTestProfile.payoutWallet &&
            BigInt(t.blockNumber) >= BigInt(from) &&
            BigInt(t.blockNumber) <= BigInt(to),
        ),
      confirmedPosition: async () => position,
      balance: async () => balance,
      position: async () => position,
      transfer: async (_p, hash) => transfers.get(hash) ?? null,
      incoming: async (_p, hash, index) => {
        const r = transfers.get(hash);
        if (!r || r.logIndex !== index) throw Error("fixture receipt missing");
        return r;
      },
    };
    const sources: RewardSources = {
      mode: "simulated",
      purchase: async (input) => ({ receiptHash: hashJson(input) }),
      qualifiers: async () => candidates,
      winnings: async () => ({
        usdcAtomic: prize,
        receiptHash: rewardHash(901),
      }),
    };
    const provider: RewardVerificationProvider = {
      open: async () => {
        const id = `provider_${++openings}`;
        subjects.set(id, null);
        return { id, launchUrl: `veros://verify?sessionId=${id}` };
      },
      subject: async (id) => subjects.get(id) ?? null,
    };
    const store = new RewardStore(runtime.db, rewardTestProfile);
    await store.init();
    const offers = new RewardOffers(store, sources, () => now),
      claims = new RewardClaims(store, provider, () => now),
      payments = new RewardPayments(store, chain, () => now);
    async function offer(id: string, ticket: string) {
      const input = {
        offerId: id,
        drawingId: ticket,
        songKey: rewardHash(500),
        opensAt: now + 1000,
        cutoffAt: now + 10000,
        purchaseHash: rewardHash(Number(ticket) + 1000),
        ticketIds: [ticket],
      };
      await offers.attach(input);
      return input;
    }
    async function settle(id: string, ticket: string) {
      const input = await offer(id, ticket);
      candidates = principals.slice(0, 2).map((p, i) => ({
        ...p,
        evidenceHash: rewardHash(i + 600),
        completedAt: input.opensAt + 1000,
      }));
      now = input.cutoffAt;
      await offers.close(id);
      await offers.settle(id);
      return input;
    }
    function receipt(
      hash: string,
      recipient: string,
      amountAtomic: string,
    ): ConfirmedTransfer {
      return {
        chainId: 6343,
        transactionHash: hash,
        blockHash: rewardHash(999),
        blockNumber: "101",
        logIndex: 2,
        sender: rewardTestProfile.payoutWallet,
        recipient,
        token: rewardTestProfile.token,
        amountAtomic,
      };
    }
    function guard(
      payment: RewardPayment,
      hash: string,
      rows: ConfirmedTransfer[] = [],
    ) {
      const proof: RewardGuardEvidence = {
        chainId: 6343,
        account: payment.sender,
        nonce: payment.guardNonce,
        transactionHash: hash,
        blockHash: rewardHash(999),
        blockNumber: "101",
        logIndex: 1,
        implementation: MOSS_GUARD_IMPLEMENTATION,
        transfers: rows,
      };
      guards.set(payment.guardNonce, proof);
      for (const row of rows) transfers.set(hash, row);
      return proof;
    }
    return {
      ...runtime,
      guards,
      guard,
      store,
      offers,
      claims,
      payments,
      provider,
      chain,
      sources,
      principals,
      subjects,
      transfers,
      offer,
      settle,
      receipt,
      now: () => now,
      setNow: (v: number) => {
        now = v;
      },
      setPrize: (v: string) => {
        prize = v;
      },
      setCandidates: (v: QualificationEntry[]) => {
        candidates = v;
      },
      setBalance: (v: string) => {
        balance = v;
      },
      setPosition: (v: string) => {
        position = v;
      },
      openings: () => openings,
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
