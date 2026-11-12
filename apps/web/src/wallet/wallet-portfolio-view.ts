import type {
  RewardCredit,
  RewardWalletView,
} from "../../../../packages/rewards/contracts.ts";
import { dollars } from "../live/reward-wallet.ts";
import { rewardWalletIdentity } from "./hosted-send.ts";
import { rewardSummary } from "./reward-status.ts";
import { formatWalletAddressLabel } from "./established/wallet-hub-view-model.ts";
import type { PersonaWallet } from "./established/wallet-portfolio-model.ts";
import type {
  WalletHubChainSection,
  WalletHubRewardsSummary,
} from "./established/wallet-hub.types.ts";

/** Optional real session metadata. No persona API, guessed display name, or new profile authority. */
export interface WalletIdentityPresentation {
  address: string;
  displayName?: string;
  avatarSrc?: string | null;
}
export function walletPortfolioView(
  view: RewardWalletView,
  credits: RewardCredit[],
  identity?: WalletIdentityPresentation,
) {
  const selectedId = rewardWalletIdentity(view),
    summary = rewardSummary(view, credits);
  const sameOwner =
    identity?.address.toLowerCase() === view.address.toLowerCase();
  const wallet: PersonaWallet = {
    personaId: selectedId,
    address: view.address,
    displayName:
      sameOwner && identity?.displayName
        ? identity.displayName
        : formatWalletAddressLabel(view.address),
    avatarSrc: sameOwner ? (identity?.avatarSrc ?? null) : null,
    publicHandle: null,
  };
  const balance =
    view.balanceAtomic === null
      ? null
      : dollars(view.balanceAtomic, view.decimals);
  const sections: WalletHubChainSection[] = [
    {
      chainId: "megaeth",
      title: "MegaETH testnet",
      availability: "ready",
      walletAddress: view.address,
      balancesUnavailable: view.balanceAtomic === null,
      tokens: [
        {
          id: view.token.toLowerCase(),
          symbol: "test USDm",
          name: "USDm",
          balance: balance === null ? "Unavailable" : balance.slice(1),
          ...(balance === null ? {} : { fiatValue: balance }),
        },
      ],
    },
  ];
  const rewards: WalletHubRewardsSummary = {
    amountLabel: dollars(summary.earned, view.decimals),
    assetLabel: "test USDm",
    actionLabel: "Verify to claim",
    supportingLabel: `Pending rewards: ${dollars(summary.pending, view.decimals)}${summary.claimable !== "0" ? ". Verify with a palm scan to claim it." : summary.held !== "0" ? ". Your amount stays held; contact support." : summary.awaiting !== "0" ? ". Awaiting payment." : ""}`,
  };
  return { wallet, selectedId, sections, balance, rewards, summary };
}
