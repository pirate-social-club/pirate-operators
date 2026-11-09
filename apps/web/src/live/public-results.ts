// V4 account settings. Turning public results off is the learner's signed
// Revocation, relayed by the community; turning them on clears the withdrawal
// and is followed by a normal sign-in. Never offered inside an exercise.
import type {
  KaraokeConsentRequest,
  KaraokeWallet,
} from "./learning-consent.ts";

export type PublicResults = "on" | "pending" | "off" | "unavailable";
/** The settings action a session offers; V3 keeps "Stop public enrollment". */
export function publicResultsAction(state: PublicResults | undefined) {
  return state === "on" || state === "pending"
    ? ("off" as const)
    : state === "off"
      ? ("on" as const)
      : ("enrollment" as const);
}

interface OffPorts {
  request(): Promise<KaraokeConsentRequest>;
  submit(
    request: KaraokeConsentRequest,
    signature: string,
  ): Promise<{ state: string }>;
  wallet: KaraokeWallet;
  status(message: string): void;
}
export async function turnOffPublicResults(ports: OffPorts): Promise<string> {
  ports.status("Confirm turning public results off in MOSS.");
  const request = await ports.request();
  if (
    request.primaryType !== "Revocation" ||
    request.target?.version !== 4 ||
    ![31337, 6343].includes(request.target.chainId) ||
    String(request.domain.verifyingContract).toLowerCase() !==
      request.target.contract.toLowerCase() ||
    Number(request.domain.chainId) !== request.target.chainId ||
    request.domain.version !== "4"
  )
    throw new Error("Public results changed. Reload and try again.");
  const signature = await ports.wallet.signConsent(request);
  const result = await ports.submit(request, signature);
  if (result.state !== "success" && result.state !== "pending")
    throw new Error("Public results could not be turned off. Try again.");
  return "Public results are off. Earlier results remain public.";
}

interface OnPorts {
  enable(): Promise<unknown>;
  /** The same normal sign-in the header offers. */
  signIn(): Promise<void>;
  status(message: string): void;
}
export async function turnOnPublicResults(ports: OnPorts): Promise<string> {
  await ports.enable();
  ports.status("Sign in with MOSS to turn public results on.");
  await ports.signIn();
  return "Public results are on. Choose a song to study or sing.";
}
