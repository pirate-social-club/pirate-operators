export interface TelegramConnectionView {
  connected: boolean;
  grantId: string | null;
  unlinkOperation: {
    operationId: string;
    expectedGrantId: string | null;
    complete: boolean;
  } | null;
  linkedAt: number | null;
  preferences: { reminders: boolean; rewards: boolean; dance: boolean } | null;
}
export class TelegramRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly transactionId: string | null;
  readonly transactionTerminated: boolean;
  constructor(
    status: number,
    code: string | null,
    transactionId: string | null = null,
    transactionTerminated = false,
  ) {
    super(code ?? "Telegram is unavailable.");
    this.status = status;
    this.code = code;
    this.transactionId = transactionId;
    this.transactionTerminated = transactionTerminated;
  }
}
export function telegramConnectionClient(options: {
  account: () => string;
  /** Existing auth/route owner increments on account, logout and route changes,
   * including an A -> B -> A switch while a response body is pending. */
  generation: () => number;
  csrf: () => string;
  fetch?: typeof fetch;
}) {
  const transport = options.fetch ?? fetch;
  const unlinks = new Map<
    string,
    { operationId: string; expectedGrantId: string | null }
  >();
  type Context = { account: string; generation: number; epoch: number };
  type Start = {
    context: Context;
    transactionId: string | null;
    phase:
      | "requesting"
      | "resumable"
      | "navigation-ready"
      | "unknown"
      | "invalid";
  };
  let observed: { account: string; generation: number } | undefined,
    epoch = 0,
    start: Start | null = null;
  const changed = () => new Error("The signed-in account changed. Try again.");
  function observe(): Context {
    const account = options.account(),
      generation = options.generation();
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw new Error("Telegram context generation is required.");
    if (
      observed &&
      (observed.account !== account || observed.generation !== generation)
    ) {
      epoch++;
      start = null;
      unlinks.clear();
    }
    observed = { account, generation };
    return { ...observed, epoch };
  }
  function capture() {
    const context = observe();
    if (!context.account) throw new Error("Sign in to continue.");
    return context;
  }
  function assertContext(context: Context) {
    const current = observe();
    if (
      current.account !== context.account ||
      current.generation !== context.generation ||
      current.epoch !== context.epoch
    )
      throw changed();
  }
  const transactionId = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  // On connect/start these codes prove that the community identity/binding
  // failed. Broker client authentication concerns the server channel and can
  // fail with the same HTTP status while this community reservation is valid.
  const communityInvalidCodes = new Set([
    "telegram_session_required",
    "telegram_csrf_required",
    "telegram_account_mismatch",
    "telegram_browser_mismatch",
    "telegram_authority_changed",
  ]);
  async function request<T>(
    path: string,
    method = "GET",
    value?: unknown,
    context = capture(),
    opening?: { expectedId: string | null },
  ): Promise<T> {
    assertContext(context);
    let response: Response;
    try {
      response = await transport(path, {
        method,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "x-telegram-account": context.account,
          ...(method === "GET"
            ? {}
            : {
                "content-type": "application/json",
                "x-csrf-token": options.csrf(),
              }),
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    } catch (error) {
      assertContext(context);
      throw error;
    }
    assertContext(context);
    let body: unknown;
    try {
      body = await response.json();
    } finally {
      // Headers and body can arrive under different UI account contexts. Fence
      // both the result and parse/read errors before exposing either to callers.
      assertContext(context);
    }
    if (!response.ok) {
      const code =
        object(body) &&
        "error" in body &&
        typeof body.error === "string" &&
        /^[a-z][a-z0-9_]{0,127}$/.test(body.error)
          ? body.error
          : null;
      // Only this start response may introduce a server transaction. A retry
      // can confirm its original ID; it cannot replace it with another one.
      const candidate = object(body) ? body.transactionId : null;
      const correlatedId =
        opening &&
        transactionId(candidate) &&
        (!opening.expectedId || opening.expectedId === candidate)
          ? candidate
          : null;
      // Community bound() owns these pairs before dispatch and after awaited
      // broker reads; broker client authentication does not produce them here.
      // Require the response's correlated T as well: ambiguous/foreign metadata
      // cannot terminate the original client operation.
      const terminated =
        correlatedId !== null &&
        ((response.status === 410 && code === "telegram_connection_expired") ||
          (response.status === 404 &&
            code === "telegram_connection_not_found"));
      const id =
        opening && code && !communityInvalidCodes.has(code) && !terminated
          ? correlatedId
          : null;
      throw new TelegramRequestError(response.status, code, id, terminated);
    }
    return body as T;
  }
  async function open(
    operation: Start,
    value: { reference: string } | { transactionId: string },
  ) {
    const context = operation.context;
    try {
      const body = await request<unknown>(
        "/api/telegram/connect/start",
        "POST",
        value,
        context,
        { expectedId: operation.transactionId },
      );
      assertContext(context);
      if (start !== operation) throw changed();
      if (
        !object(body) ||
        !transactionId(body.transactionId) ||
        (operation.transactionId &&
          operation.transactionId !== body.transactionId) ||
        typeof body.navigationUrl !== "string" ||
        body.navigationUrl.length > 4096
      )
        throw new Error("The connection response is invalid.");
      let navigation: URL;
      try {
        navigation = new URL(body.navigationUrl);
      } catch {
        throw new Error("The connection response is invalid.");
      }
      if (
        navigation.protocol !== "https:" ||
        navigation.username ||
        navigation.password
      )
        throw new Error("The connection response is invalid.");
      operation.transactionId = body.transactionId;
      operation.phase = "navigation-ready";
      return {
        transactionId: body.transactionId,
        navigationUrl: body.navigationUrl,
      };
    } catch (error) {
      assertContext(context);
      if (start === operation) {
        if (
          error instanceof TelegramRequestError &&
          (error.transactionTerminated ||
            (error.code !== null && communityInvalidCodes.has(error.code)))
        ) {
          operation.transactionId = null;
          operation.phase = "invalid";
        } else {
          if (error instanceof TelegramRequestError && error.transactionId)
            operation.transactionId = error.transactionId;
          operation.phase = operation.transactionId ? "resumable" : "unknown";
        }
      }
      throw error;
    }
  }
  return {
    /** Memory-only status; neither identity nor a substitute for server binding. */
    pendingStart() {
      observe();
      return start
        ? { transactionId: start.transactionId, phase: start.phase }
        : null;
    },
    /** Local route cancellation only; no invented server cancellation endpoint. */
    cancel() {
      epoch++;
      start = null;
      unlinks.clear();
    },
    status: () => request<TelegramConnectionView>("/api/telegram/connection"),
    async unlink() {
      const context = capture(),
        account = context.account;
      let operation = unlinks.get(account);
      if (!operation) {
        const status = await request<TelegramConnectionView>(
          "/api/telegram/connection",
          "GET",
          undefined,
          context,
        );
        assertContext(context);
        const previous = status.unlinkOperation;
        operation =
          previous &&
          (!previous.complete ||
            previous.expectedGrantId === status.grantId ||
            !status.connected)
            ? {
                operationId: previous.operationId,
                expectedGrantId: previous.expectedGrantId,
              }
            : {
                operationId: crypto.randomUUID(),
                expectedGrantId: status.grantId,
              };
        unlinks.set(account, operation);
      }
      try {
        const result = await request<{ unlinked: boolean }>(
          "/api/telegram/connection",
          "DELETE",
          operation,
          context,
        );
        if (unlinks.get(account) === operation) unlinks.delete(account);
        return result;
      } catch (error) {
        if (
          error instanceof TelegramRequestError &&
          error.status === 409 &&
          error.code === "telegram_unlink_predecessor_changed" &&
          unlinks.get(account) === operation
        )
          unlinks.delete(account);
        throw error;
      }
    },
    preferences: (value: NonNullable<TelegramConnectionView["preferences"]>) =>
      request("/api/telegram/notifications", "PATCH", value),
    async start(reference: string) {
      const context = capture();
      if (start)
        throw new Error("Resume or cancel the pending Telegram connection.");
      if (!transactionId(reference))
        throw new Error("The connection link is invalid.");
      start = { context, transactionId: null, phase: "requesting" };
      return open(start, { reference });
    },
    async retryStart(id?: string) {
      const context = capture();
      if (
        !start?.transactionId ||
        start.phase === "requesting" ||
        (id !== undefined && id !== start.transactionId)
      )
        throw new Error("No matching resumable Telegram connection.");
      assertContext(start.context);
      const operation = start,
        originalId = operation.transactionId!;
      assertContext(context);
      operation.phase = "requesting";
      return open(operation, { transactionId: originalId });
    },
    async complete(url: URL, replaceUrl: (value: string) => void) {
      const context = capture();
      const get = (key: string) => {
        const values = url.searchParams.getAll(key);
        if (values.length !== 1 || !values[0] || values[0].length > 4096)
          throw new Error("The connection link is invalid.");
        return values[0];
      };
      const transactionId = get("transactionId"),
        state = get("state"),
        code = get("code");
      // The server verifies current account/browser/state on both the GET and
      // completion POST. Keep the single-use callback available for a retry
      // until acknowledgement; no JWT, wallet cookie or reusable login token.
      await request(
        `/telegram/connect/return?transactionId=${encodeURIComponent(transactionId)}&state=${encodeURIComponent(state)}`,
        "GET",
        undefined,
        context,
      );
      const result = await request<{ connected: true; linkedAt: number }>(
        "/api/telegram/connect/complete",
        "POST",
        { transactionId, state, code },
        context,
      );
      assertContext(context);
      start = null;
      replaceUrl(url.pathname);
      return result;
    },
  };
}
