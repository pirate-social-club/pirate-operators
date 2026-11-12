import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import type { RewardsData } from "../live/rewards-data.ts";
import type { WalletSendAdapterV1 } from "./contracts.ts";
import type { WalletIdentityPresentation } from "./wallet-portfolio-view.ts";

export interface LiveRewardWalletProps {
  csrf: string;
  onExit: () => void;
  data?: RewardsData;
  send?: (view: RewardWalletView) => Promise<void>;
  sendAdapter?: WalletSendAdapterV1;
  onAccountChanged?: () => void;
  /** Optional existing session presentation, accepted only for this exact MOSS address. */
  identity?: WalletIdentityPresentation;
}
