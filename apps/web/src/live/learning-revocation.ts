import type {
  KaraokeConsentRequest,
  KaraokeWallet,
} from "./learning-consent.ts";

type Target = NonNullable<KaraokeConsentRequest["target"]>;
export interface LearningEnrollments {
  grants: { target: Target; revocationPending: boolean }[];
  pendingEnrollment: boolean;
}
interface Ports {
  list(): Promise<LearningEnrollments>;
  request(target: Target): Promise<KaraokeConsentRequest>;
  submit(
    request: KaraokeConsentRequest,
    signature: string,
  ): Promise<{ state: string }>;
  wallet: KaraokeWallet;
  status(message: string): void;
}

/** Each contract needs its own learner signature; confirm all reads before success. */
export async function stopPublicEnrollment(ports: Ports): Promise<string> {
  const initial = await ports.list();
  if (initial.pendingEnrollment)
    return "An enrollment is still confirming. Try stopping public enrollment again once it confirms.";
  if (!initial.grants.length)
    return "Public learning results are not enabled for this wallet.";
  for (const [index, grant] of initial.grants.entries()) {
    if (grant.revocationPending) continue;
    ports.status(
      `Confirm stopping public enrollment ${index + 1} of ${initial.grants.length} in MOSS.`,
    );
    const request = await ports.request(grant.target);
    if (
      request.primaryType !== "Revocation" ||
      request.target?.chainId !== grant.target.chainId ||
      request.target.version !== grant.target.version ||
      request.target.contract.toLowerCase() !==
        grant.target.contract.toLowerCase()
    )
      throw new Error("The enrollment changed. Reload and try again.");
    const signature = await ports.wallet.signConsent(request);
    const result = await ports.submit(request, signature);
    if (result.state !== "success" && result.state !== "pending")
      throw new Error(
        "An enrollment could not be stopped. Try again to stop any remaining public enrollment.",
      );
  }
  const remaining = await ports.list();
  return !remaining.pendingEnrollment && !remaining.grants.length
    ? "Public enrollment stopped. Earlier publications remain public."
    : "Some public enrollment is still active or confirming. Check again shortly to finish stopping it.";
}
