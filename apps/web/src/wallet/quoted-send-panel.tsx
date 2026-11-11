import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import type { WalletSendAdapterV1 } from "./contracts.ts";
import { WalletSendPanel } from "./send-panel.tsx";

/** Retained export; the accepted sheet supplies the entire view and machine. */
export function QuotedSendPanel(props: {
  view: RewardWalletView;
  adapter: WalletSendAdapterV1;
  onClose?: () => void;
}) {
  return (
    <WalletSendPanel
      view={props.view}
      adapter={props.adapter}
      onClose={() => props.onClose?.()}
    />
  );
}
