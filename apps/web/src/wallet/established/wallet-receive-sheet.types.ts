// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import type { WalletHubChainSection } from "./wallet-hub.types";

export interface WalletReceiveSheetProps {
  chainSections: WalletHubChainSection[];
  forceMobile?: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  walletAddress?: string | null;
}
