// COORDINATOR MOUNT PROPOSAL ONLY. Uses existing shell/account/login state;
// supplies no UI, new endpoint, broker selection or localStorage auth.
import { telegramConnectionClient } from "./client.ts";

export function telegramAccountLinkController(options: {
  account(): string;
  generation(): number;
  csrf(): string;
  /** Explicit already selected HTTPS community origin; no domain default. */
  origin: string;
  navigate(url: string): void;
  replaceUrl(path: string): void;
  fetch?: typeof fetch;
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.origin !== options.origin)
    throw Error("Invalid community origin.");
  const client = telegramConnectionClient(options);
  async function navigate(open: () => ReturnType<typeof client.start>) {
    const account = options.account(),
      generation = options.generation();
    const result = await open();
    if (options.account() !== account || options.generation() !== generation)
      throw Error("The signed-in account changed. Try again.");
    options.navigate(result.navigationUrl);
    return result;
  }
  return {
    pending: client.pendingStart,
    start: (reference: string) => navigate(() => client.start(reference)),
    // The explicit retry button uses retained server identity. It never
    // reopens a consumed reference or guesses another broker transaction.
    retry: () => navigate(() => client.retryStart()),
    async returned(url: URL) {
      if (
        url.origin !== options.origin ||
        url.pathname !== "/telegram/connect/return"
      )
        throw Error("Invalid connection return.");
      return client.complete(url, options.replaceUrl);
    },
    cancel: client.cancel,
    // Shell/account/logout/route disposal calls this, and increments the
    // monotonic generation even for A -> B -> A transitions between awaits.
    dispose: client.cancel,
  };
}
