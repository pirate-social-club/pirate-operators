import type {
  RewardOffer,
  RewardPayment,
} from "../../../../packages/rewards/contracts.ts";
import type {
  RewardOperatorView,
  RewardsData,
} from "../live/rewards-data.ts";

export type RewardOperatorStoryScenario = "ready" | "loading" | "failure";

const token = `0x${"33".repeat(20)}`;
const payoutWallet = `0x${"44".repeat(20)}`;
const learnerWallet = `0x${"55".repeat(20)}`;
const accountId = "11111111-1111-4111-8111-111111111111";
const now = Date.UTC(2026, 10, 25, 12, 0, 0);

const offer: RewardOffer = {
  offerId: "offer-rehearsal-paper-moon",
  drawingId: "rehearsal-drawing-1",
  songKey: "paper-moon",
  cutoffAt: now + 3600000,
  opensAt: now - 120000,
  purchaseHash: `0x${"aa".repeat(32)}`,
  ticketIds: ["ticket-1", "ticket-2"],
  resultSources: [`0x${"bb".repeat(32)}`],
  evidenceMode: "simulated",
  state: "open",
  entries: [],
  winningsUsdcAtomic: "25000000",
  payoutAtomic: null,
  remainderAtomic: null,
};

const payment: RewardPayment = {
  paymentId: "payment-prepared-1",
  accountId,
  sender: payoutWallet,
  recipient: learnerWallet,
  chainId: 6343,
  token,
  decimals: 6,
  amountAtomic: "25000000",
  creditIds: ["credit-1"],
  state: "prepared",
  transactionHash: null,
  preparedAt: now - 60000,
  guardNonce: "7",
  everDispatched: false,
  latestAttemptId: null,
  attempts: [],
};

const view: RewardOperatorView = {
  offers: [offer],
  payments: [payment],
  ready: [],
  inventory: {
    received_atomic: "100000000",
    reserved_atomic: "25000000",
    paid_atomic: "10000000",
    cost_atomic: "1000000",
  },
  payoutWallet,
  liabilities: {
    total: "25000000",
    unclaimed: "0",
    held: "0",
    accepted: "25000000",
  },
  practiceOnly: true,
  funding: [],
  decimals: 6,
  token,
  chainId: 6343,
  simulatedWinnings: true,
  rehearsal: null,
  songs: [{ songKey: "paper-moon", title: "Paper Moon" }],
  unmatched: [],
  observedBalanceAtomic: "64000000",
};

const unavailable = async (): Promise<never> => {
  throw Error("This action is not available in the catalog fixture.");
};

/** Mock the operator route's data port, never the panel's presentation props. */
export function createRewardOperatorStoryData(
  scenario: RewardOperatorStoryScenario,
): RewardsData {
  return {
    wallet: unavailable,
    credits: unavailable,
    claim: unavailable,
    intent: unavailable,
    poll: unavailable,
    async operator() {
      if (scenario === "loading") return new Promise(() => {});
      if (scenario === "failure") throw Error("Reward service unavailable.");
      return view;
    },
    async operation<T>(path: string): Promise<T> {
      if (path === "/payments") return payment as T;
      throw Error(`The catalog fixture does not write ${path}.`);
    },
  };
}
