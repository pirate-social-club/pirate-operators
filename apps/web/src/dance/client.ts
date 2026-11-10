import type {
  DanceCapture,
  DanceQueue,
  DanceReceipt,
  DanceReview,
} from "../../../../packages/dance/contracts.ts";

export interface DanceClient {
  capture(
    songKey: string,
    offerId: string | null,
    referenceId: string | null,
  ): Promise<DanceCapture>;
  submit(captureId: string, mediaId: string): Promise<DanceReceipt>;
  get(reviewId: string): Promise<DanceReview>;
  queue(cursor?: string | null): Promise<DanceQueue>;
  decide(
    reviewId: string,
    revision: number,
    verdict: "passed" | "not_passed",
  ): Promise<DanceReceipt>;
  withdraw(reviewId: string, revision: number): Promise<DanceReceipt>;
  dispose(): void;
}
export class DanceClientError extends Error {
  readonly code: string;
  readonly unknown: boolean;
  readonly status: number | undefined;
  constructor(code: string, unknown = false, status?: number) {
    super(code);
    this.code = code;
    this.unknown = unknown;
    this.status = status;
  }
}
/** One client per authenticated account. Dispose on logout/account/community change.
 * Commands survive ambiguous responses in memory; refresh reconciles server state.
 * No authentication or media is persisted in browser storage.
 */
export function createDanceClient(options: {
  accountId: string;
  csrf: string;
  fetcher?: typeof fetch;
  isCurrent: () => boolean;
}): DanceClient {
  const controller = new AbortController(),
    fetcher = options.fetcher ?? fetch;
  const commands = new Map<string, string>();
  function current() {
    if (controller.signal.aborted || !options.isCurrent())
      throw new DanceClientError("dance_account_changed");
  }
  async function request<T>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    current();
    const stable = body ? JSON.stringify([path, body]) : "";
    if (body && !commands.has(stable))
      commands.set(stable, crypto.randomUUID());
    let response: Response;
    try {
      response = await fetcher(`/api/dance/${path}`, {
        method: body ? "POST" : "GET",
        credentials: "same-origin",
        signal: controller.signal,
        cache: "no-store",
        headers: {
          "x-dance-account": options.accountId,
          ...(body
            ? {
                "content-type": "application/json",
                "x-csrf-token": options.csrf,
              }
            : {}),
        },
        body: body
          ? JSON.stringify({ ...body, commandId: commands.get(stable) })
          : undefined,
      });
    } catch {
      current();
      throw new DanceClientError("dance_response_unknown", !!body);
    }
    current();
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new DanceClientError("dance_response_unknown", !!body);
    }
    current();
    if (!response.ok) {
      const code =
        value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string"
          ? value.error
          : "dance_request_failed";
      throw new DanceClientError(
        code,
        response.status >= 500 && !!body,
        response.status,
      );
    }
    // Successful capture reservation completes that user intent. A later new
    // performance must reserve fresh terms rather than recover this capture.
    if (body && path === "captures") commands.delete(stable);
    return value as T;
  }
  return {
    capture: (songKey, offerId, referenceId) =>
      request("captures", { songKey, offerId, referenceId }),
    submit: (captureId, mediaId) => request("reviews", { captureId, mediaId }),
    get: (id) => request(`reviews/${encodeURIComponent(id)}`),
    queue: (cursor) =>
      request(`queue${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    decide: (id, revision, verdict) =>
      request(`reviews/${encodeURIComponent(id)}/verdict`, {
        revision,
        verdict,
      }),
    withdraw: (id, revision) =>
      request(`reviews/${encodeURIComponent(id)}/withdraw`, { revision }),
    dispose: () => {
      controller.abort();
      commands.clear();
    },
  };
}
