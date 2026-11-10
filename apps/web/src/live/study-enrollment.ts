import type {
  KaraokeConsentRequest,
  KaraokeWallet,
} from "./learning-consent.ts";
import { enrollmentDisclosure } from "./learning-consent.ts";

export type StudyEnrollmentView = Partial<KaraokeConsentRequest> & {
  active?: boolean;
  pending?: boolean;
  activities?: number;
};
interface Ports {
  active?(): boolean;
  request(): Promise<StudyEnrollmentView>;
  submit(
    request: KaraokeConsentRequest,
    signature: string,
  ): Promise<{ state: string }>;
  wallet: KaraokeWallet;
}

/** Called only before a new lesson; an existing lesson keeps its frozen grant. */
export async function ensureStudyEnrollment(ports: Ports): Promise<void> {
  const stillOpen = () => {
    if (ports.active?.() === false) throw new Error("Study was closed.");
  };
  stillOpen();
  const view = await ports.request();
  stillOpen();
  if (
    view.target?.version !== 3 ||
    ![31337, 6343].includes(view.target.chainId)
  )
    throw new Error(
      "Study is unavailable until its learning service is ready.",
    );
  if (view.pending)
    throw new Error("Your enrollment is confirming. Try again shortly.");
  if (view.active) {
    if (view.activities !== 2 && view.activities !== 3)
      throw new Error("Study needs a new public learning enrollment.");
    return;
  }
  if (
    view.primaryType !== "Enrollment" ||
    !view.domain ||
    !view.types ||
    !view.message ||
    !["2", "3"].includes(String(view.message.activities)) ||
    String(view.domain.verifyingContract).toLowerCase() !==
      view.target.contract.toLowerCase() ||
    Number(view.domain.chainId) !== view.target.chainId
  )
    throw new Error("This enrollment changed. Reload and try again.");
  const request = view as KaraokeConsentRequest;
  enrollmentDisclosure(request);
  const signature = await ports.wallet.signConsent(request);
  stillOpen();
  const accepted = await ports.submit(request, signature);
  stillOpen();
  if (accepted.state !== "success")
    throw new Error(
      "Your enrollment is confirming. Try again once it is confirmed.",
    );
}
