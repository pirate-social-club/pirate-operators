// Presentation-only identity shape from the pinned WalletPortfolio. The MOSS service port supplies its one real account.
export interface PersonaWallet {
  personaId: string;
  displayName: string;
  publicHandle: string | null;
  avatarSrc: string | null;
  address: string | null;
}
