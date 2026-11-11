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
export function telegramConnectionClient(options: {
  account: () => string;
  csrf: () => string;
  fetch?: typeof fetch;
}) {
  const transport = options.fetch ?? fetch;
  const unlinks = new Map<
    string,
    { operationId: string; expectedGrantId: string | null }
  >();
  async function request<T>(
    path: string,
    method = "GET",
    value?: unknown,
  ): Promise<T> {
    const account = options.account();
    if (!account) throw new Error("Sign in to continue.");
    const assertAccount = () => {
      if (options.account() !== account)
        throw new Error("The signed-in account changed. Try again.");
    };
    const response = await transport(path, {
      method,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "x-telegram-account": account,
        ...(method === "GET"
          ? {}
          : {
              "content-type": "application/json",
              "x-csrf-token": options.csrf(),
            }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    assertAccount();
    let body;
    try {
      body = await response.json();
    } finally {
      // Headers and body can arrive under different UI account contexts. Fence
      // both the result and parse/read errors before exposing either to callers.
      assertAccount();
    }
    if (!response.ok)
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : "Telegram is unavailable.",
      );
    return body as T;
  }
  return {
    status: () => request<TelegramConnectionView>("/api/telegram/connection"),
    async unlink() {
      const account = options.account();
      let operation = unlinks.get(account);
      if (!operation) {
        const status = await request<TelegramConnectionView>(
          "/api/telegram/connection",
        );
        if (options.account() !== account)
          throw new Error("The signed-in account changed. Try again.");
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
      const result = await request<{ unlinked: boolean }>(
        "/api/telegram/connection",
        "DELETE",
        operation,
      );
      if (unlinks.get(account) === operation) unlinks.delete(account);
      return result;
    },
    preferences: (value: NonNullable<TelegramConnectionView["preferences"]>) =>
      request("/api/telegram/notifications", "PATCH", value),
    start: (reference: string) =>
      request<{ transactionId: string; navigationUrl: string }>(
        "/api/telegram/connect/start",
        "POST",
        { reference },
      ),
    retryStart: (transactionId: string) =>
      request<{ transactionId: string; navigationUrl: string }>(
        "/api/telegram/connect/start",
        "POST",
        { transactionId },
      ),
    async complete(url: URL, replaceUrl: (value: string) => void) {
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
      );
      const result = await request<{ connected: true; linkedAt: number }>(
        "/api/telegram/connect/complete",
        "POST",
        { transactionId, state, code },
      );
      replaceUrl(url.pathname);
      return result;
    },
  };
}
