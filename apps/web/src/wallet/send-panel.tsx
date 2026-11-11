import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import type { WalletSendAdapterV1 } from "./contracts.ts";
import { rewardWalletIdentity } from "./hosted-send.ts";
import { mossSponsoredSendDependencies } from "./moss-sponsored-send.ts";
import { WalletSponsoredSendSheet } from "./established/wallet-sponsored-send-sheet.tsx";

export interface WalletSendPanelProps {
  view: RewardWalletView;
  adapter?: WalletSendAdapterV1;
  send?: (view: RewardWalletView) => Promise<void>;
  onClose: () => void;
  onConfirmed?: () => void;
}
/** Compatibility seam only; the accepted composition and its machine render the entire sheet. */
export function WalletSendPanel(props: WalletSendPanelProps) {
  const dependencies = mossSponsoredSendDependencies({
    view: () => props.view,
    adapter: props.adapter,
    send: props.send,
  });
  return (
    <WalletSponsoredSendSheet
      accountId={props.view.address}
      personaId={rewardWalletIdentity(props.view)}
      walletAddress={props.view.address}
      onClose={props.onClose}
      onConfirmed={props.onConfirmed}
      dependencies={dependencies}
    />
  );
}
