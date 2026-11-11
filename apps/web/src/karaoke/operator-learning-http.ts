/** Owned same-origin operator transport. No central API, auth or persona port. */
export class LearningServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export async function learningRequest<T>(
  path: string,
  options: {
    account: string;
    csrf: string;
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<T> {
  if (!path.startsWith("/api/") || path.startsWith("//"))
    throw new Error("Learning requires the community's own service.");
  async function requireCurrentAccount() {
    const response = await fetch("/api/session", {
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw new LearningServiceError(
        response.status,
        "learning_session_unavailable",
        response.status === 401
          ? "Sign in to continue."
          : "Your account could not be checked. Retry the same step.",
      );
    const session = (await response.json()) as { mossAddress?: string } | null;
    if (session?.mossAddress?.toLowerCase() !== options.account.toLowerCase())
      throw new LearningServiceError(
        401,
        "study_account_changed",
        "You are signed in with a different account. Reload to continue.",
      );
  }
  // Existing MOSS session, never central auth. The post-read check prevents a
  // response from another account being installed after a cross-tab sign-in.
  // The server still owns authorization; this is a presentation lifetime fence.
  await requireCurrentAccount();
  const response = await fetch(path, {
    method: options.body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
    headers: {
      accept: "application/json",
      "x-study-account": options.account,
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json", "x-csrf-token": options.csrf }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const value = await response.json();
  await requireCurrentAccount();
  if (!response.ok) {
    const code =
      typeof value.error === "string" ? value.error : "learning_unavailable";
    const message =
      response.status === 401
        ? "Sign in to continue."
        : code === "karaoke_authorization_pending"
          ? "Your sign-in is still being confirmed. Try again in a moment."
          : code === "study_account_changed"
            ? "You are signed in with a different account. Reload to continue."
            : code === "speech_budget_exhausted"
              ? "Speech practice has reached today's community limit."
              : code === "sponsor_exhausted"
                ? "Sponsored practice is paused because the community allowance is exhausted."
                : "This step could not complete. Retry the same step.";
    throw new LearningServiceError(response.status, code, message);
  }
  return value as T;
}
