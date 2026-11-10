/** Standing enrollment or revocation; sponsored by the community. */
export interface KaraokeConsentRequest {
  target?: { chainId: number; version: 2 | 3 | 4; contract: string };
  disclosure?: {
    version: 3;
    termsUrl: string;
    privacyUrl: string;
    publicityPolicy: string;
  };
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: "Consent" | "Enrollment" | "Revocation";
  message: Record<string, unknown>;
}

/** A successor prompt must link the disclosure bound by its exact signature. */
export function enrollmentDisclosure(request: KaraokeConsentRequest) {
  if (request.target?.version === 3 || request.domain.version === "3") {
    const disclosure = request.disclosure;
    if (
      request.target?.version !== 3 ||
      request.domain.version !== "3" ||
      disclosure?.version !== 3 ||
      disclosure.termsUrl !== "/learning/v3/terms" ||
      disclosure.privacyUrl !== "/learning/v3/privacy" ||
      !/^0x[0-9a-f]{64}$/i.test(disclosure.publicityPolicy) ||
      disclosure.publicityPolicy.toLowerCase() !==
        String(request.message.publicityPolicy).toLowerCase()
    )
      throw new Error(
        "This enrollment disclosure changed. Reload and try again.",
      );
    return disclosure;
  }
  return { termsUrl: "/terms", privacyUrl: "/privacy" };
}
export interface KaraokeWallet {
  /** The learner's own signature; MOSS in the live app. */
  signConsent(request: KaraokeConsentRequest): Promise<string>;
}
