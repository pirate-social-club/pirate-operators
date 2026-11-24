import type {
  RewardWalletView,
} from "../../../../packages/rewards/contracts.ts";
import type { RewardsData } from "../live/rewards-data.ts";

export type WalletStoryScenario = "ready" | "loading" | "failure" | "zero";

const address = `0x${"11".repeat(20)}`;
const token = `0x${"33".repeat(20)}`;
const accountId = "11111111-1111-4111-8111-111111111111";

const wallet: RewardWalletView & { accountId: string } = {
  accountId,
  schema: "pirate.learner-wallet/1",
  address,
  chainId: 6343,
  token,
  decimals: 18,
  balanceAtomic: "30000000000000000",
  operator: false,
  practiceOnly: true,
  drawings: [],
};

const unavailable = async (): Promise<never> => {
  throw Error("This action is not available in the catalog fixture.");
};

/** Mock the route's data port, never WalletPortfolio's presentation props. */
export function createWalletStoryData(scenario: WalletStoryScenario): RewardsData {
  return {
    async wallet() {
      if (scenario === "loading") return new Promise(() => {});
      if (scenario === "failure") throw Error("Wallet service unavailable.");
      return {
        ...wallet,
        balanceAtomic: scenario === "zero" ? "0" : wallet.balanceAtomic,
      };
    },
    async credits() {
      return [];
    },
    claim: unavailable,
    intent: unavailable,
    poll: unavailable,
    operator: unavailable,
    operation: unavailable,
  };
}
