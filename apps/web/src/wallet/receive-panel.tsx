import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import { WalletReceiveSheet } from "./established/wallet-receive-sheet.tsx";
import { walletPortfolioView } from "./wallet-portfolio-view.ts";

/** Retained entry; ReceiveSheet owns the accepted responsive dialog and selection model. */
export function WalletReceivePanel(props: {
  view: RewardWalletView;
  onClose: () => void;
}) {
  return (
    <WalletReceiveSheet
      open
      walletAddress={props.view.address}
      chainSections={walletPortfolioView(props.view, []).sections}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    />
  );
}
