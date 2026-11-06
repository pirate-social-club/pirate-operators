/** Standing enrollment or revocation; sponsored by the community. */
export interface KaraokeConsentRequest {
  target?: { chainId: number; version: 2 | 3; contract: string };
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: "Consent" | "Enrollment" | "Revocation";
  message: Record<string, unknown>;
}
export interface KaraokeWallet {
  /** The learner's own signature; MOSS in the live app. */
  signConsent(request: KaraokeConsentRequest): Promise<string>;
}
