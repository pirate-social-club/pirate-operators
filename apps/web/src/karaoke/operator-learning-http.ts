/** Owned same-origin operator transport. No central API, auth or persona port. */
export interface LearningRequestEvidence {
  readonly stage: "before_dispatch" | "endpoint_refusal" | "response_uncertain";
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly endpointStatus?: number;
}
export class LearningServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly evidence?: Readonly<LearningRequestEvidence>;
  constructor(
    status: number,
    code: string,
    message: string,
    evidence?: LearningRequestEvidence,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.evidence = evidence ? Object.freeze({ ...evidence }) : undefined;
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
  const method = options.body === undefined ? "GET" : "POST";
  const uncertain = (
    error: unknown,
    stage: LearningRequestEvidence["stage"],
    endpointStatus?: number,
  ) =>
    new LearningServiceError(
      error instanceof LearningServiceError ? error.status : 503,
      error instanceof LearningServiceError
        ? error.code
        : "learning_response_uncertain",
      error instanceof LearningServiceError
        ? error.message
        : "This step's outcome could not be confirmed. Check the same step again.",
      {
        stage,
        path,
        method,
        ...(endpointStatus === undefined ? {} : { endpointStatus }),
      },
    );
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
  try {
    await requireCurrentAccount();
  } catch (error) {
    throw uncertain(error, "before_dispatch");
  }
  let response: Response | undefined;
  let value: T & { error?: unknown };
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
      headers: {
        accept: "application/json",
        "x-study-account": options.account,
        ...(options.body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "x-csrf-token": options.csrf,
            }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    value = await response.json();
  } catch (error) {
    // Dispatch may already have committed even if the body or transport failed.
    throw uncertain(error, "response_uncertain", response?.status);
  }
  if (!response) throw uncertain(undefined, "response_uncertain");
  if (!response.ok) {
    const code =
      value && typeof value.error === "string"
        ? value.error
        : "learning_unavailable";
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
    throw new LearningServiceError(response.status, code, message, {
      stage:
        value &&
        typeof value.error === "string" &&
        response.status < 500 &&
        response.status !== 408
          ? "endpoint_refusal"
          : "response_uncertain",
      path,
      method,
      endpointStatus: response.status,
    });
  }
  try {
    await requireCurrentAccount();
  } catch (error) {
    // A successful endpoint response followed by a 401/409 session check is
    // post-dispatch uncertainty, never evidence that the endpoint refused work.
    throw uncertain(error, "response_uncertain", response.status);
  }
  return value as T;
}
