import {
  TelegramError,
  telegramCheck,
  type BotScope,
  type WebAccount,
} from "../packages/telegram/contracts.ts";
import type { NotificationPreferences } from "../packages/telegram/contracts.ts";
import type { BrokerRequest } from "../packages/telegram/link-contracts.ts";
import {
  browserCookie,
  cookie,
  httpsOrigin,
  privateHeaders,
  randomToken,
  readJson,
} from "../packages/telegram/security.ts";
import type { TelegramLoginBroker } from "./telegram-broker.ts";
import type { TelegramLinking } from "./telegram-linking.ts";

export const TELEGRAM_CONNECT_COOKIE = "__Host-telegram-connect";
export const TELEGRAM_BROKER_COOKIE = "__Host-telegram-broker";
export interface TelegramWebPorts {
  origin: string;
  scope: BotScope;
  /** Existing community session reader. Bot/link tokens never enter here. */
  account(request: Request): Promise<WebAccount>;
  /** Existing session-bound CSRF check; absence never becomes approval. */
  csrf(request: Request, account: WebAccount): Promise<boolean>;
}
function query(url: URL, key: string) {
  const values = url.searchParams.getAll(key);
  telegramCheck(
    values.length === 1 && values[0].length > 0 && values[0].length <= 4096,
    "telegram_query_invalid",
  );
  return values[0];
}
const reply = (value: unknown, status = 200, extra?: HeadersInit) => {
  const headers = new Headers({
    ...privateHeaders(),
    "content-type": "application/json",
  });
  for (const [key, value] of new Headers(extra)) headers.set(key, value);
  return new Response(JSON.stringify(value), { status, headers });
};
const failure = (error: unknown, extra?: HeadersInit) =>
  reply(
    {
      error:
        error instanceof TelegramError ? error.code : "telegram_unavailable",
    },
    error instanceof TelegramError ? error.status : 503,
    extra,
  );
const fields = (value: unknown, allowed: string[]): Record<string, unknown> => {
  telegramCheck(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((k) => allowed.includes(k)),
    "telegram_input_invalid",
  );
  return value as Record<string, unknown>;
};
const string = (value: unknown) => {
  telegramCheck(
    typeof value === "string" && value.length > 0 && value.length <= 4096,
    "telegram_input_invalid",
  );
  return value;
};

export function telegramCommunityRoutes(
  linking: TelegramLinking,
  ports: TelegramWebPorts,
) {
  const origin = httpsOrigin(ports.origin);
  return async (request: Request): Promise<Response> => {
    let setCookie: string | undefined;
    try {
      const url = new URL(request.url);
      telegramCheck(url.origin === origin, "telegram_wrong_origin", 403);
      const account = await ports.account(request);
      telegramCheck(
        account.communityId === ports.scope.communityId,
        "telegram_account_mismatch",
        403,
      );
      if (!["GET", "HEAD"].includes(request.method))
        telegramCheck(
          request.headers.get("origin") === origin &&
            request.headers.get("x-telegram-account") === account.accountId &&
            (await ports.csrf(request, account)),
          "telegram_csrf_required",
          403,
        );
      if (url.pathname === "/api/telegram/connection") {
        if (request.method === "GET") {
          const grant = linking.connection(ports.scope, account.accountId);
          return reply({
            connected: !!grant,
            linkedAt: grant?.linkedAt ?? null,
            preferences: grant
              ? linking.grants.preferences({
                  ...ports.scope,
                  userId: grant.userId,
                  chatId: grant.userId,
                })
              : null,
          });
        }
        if (request.method === "DELETE")
          return reply({
            unlinked: linking.grants.unlink(ports.scope, account.accountId),
          });
      }
      if (
        url.pathname === "/api/telegram/notifications" &&
        request.method === "PATCH"
      ) {
        const grant = linking.connection(ports.scope, account.accountId);
        telegramCheck(grant, "telegram_connection_required", 403);
        return reply(
          linking.grants.setAccountPreferences(
            ports.scope,
            account.accountId,
            (await readJson(request, 1024)) as NotificationPreferences,
          ),
        );
      }
      if (
        url.pathname === "/api/telegram/connect/start" &&
        request.method === "POST"
      ) {
        const input = fields(await readJson(request, 2048), [
          "reference",
          "transactionId",
        ]);
        telegramCheck(
          !!input.reference !== !!input.transactionId,
          "telegram_input_invalid",
        );
        let browserSecret: string;
        try {
          browserSecret = cookie(request, TELEGRAM_CONNECT_COOKIE);
        } catch (error) {
          if (input.transactionId) throw error;
          browserSecret = randomToken();
        }
        setCookie = browserCookie(TELEGRAM_CONNECT_COOKIE, browserSecret);
        const transactionId = input.transactionId
          ? string(input.transactionId)
          : (
              await linking.create(
                string(input.reference),
                account,
                browserSecret,
              )
            ).id;
        try {
          return reply(
            await linking.open(transactionId, account, browserSecret),
            200,
            { "set-cookie": setCookie },
          );
        } catch (error) {
          // Retry the same account/browser transaction after an uncertain
          // backchannel response; never create another association silently.
          return reply(
            {
              transactionId,
              error:
                error instanceof TelegramError
                  ? error.code
                  : "telegram_unavailable",
            },
            error instanceof TelegramError ? error.status : 503,
            { "set-cookie": setCookie },
          );
        }
      }
      if (
        url.pathname === "/telegram/connect/return" &&
        request.method === "GET"
      ) {
        return reply(
          await linking.inspect(
            query(url, "transactionId"),
            query(url, "state"),
            account,
            cookie(request, TELEGRAM_CONNECT_COOKIE),
          ),
        );
      }
      if (
        url.pathname === "/api/telegram/connect/complete" &&
        request.method === "POST"
      ) {
        const input = fields(await readJson(request, 4096), [
          "transactionId",
          "state",
          "code",
        ]);
        const grant = await linking.complete(
          string(input.transactionId),
          string(input.state),
          string(input.code),
          account,
          cookie(request, TELEGRAM_CONNECT_COOKIE),
        );
        return reply({ connected: true, linkedAt: grant.linkedAt });
      }
      return reply({ error: "not_found" }, 404);
    } catch (error) {
      return failure(
        error,
        setCookie ? { "set-cookie": setCookie } : undefined,
      );
    }
  };
}

export function telegramBrokerRoutes(broker: TelegramLoginBroker) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      telegramCheck(url.origin === broker.origin, "telegram_wrong_origin", 403);
      if (url.pathname === "/telegram/oidc/start" && request.method === "GET") {
        let browserSecret: string;
        try {
          browserSecret = cookie(request, TELEGRAM_BROKER_COOKIE);
        } catch {
          browserSecret = randomToken();
        }
        const result = await broker.begin(query(url, "handle"), browserSecret);
        return new Response(null, {
          status: 303,
          headers: {
            ...privateHeaders(),
            location: result.authorizationUrl,
            "set-cookie": browserCookie(TELEGRAM_BROKER_COOKIE, browserSecret),
          },
        });
      }
      if (
        url.pathname === "/telegram/oidc/callback" &&
        request.method === "GET"
      ) {
        const result = await broker.callback(
          query(url, "state"),
          query(url, "code"),
          cookie(request, TELEGRAM_BROKER_COOKIE),
        );
        return new Response(null, {
          status: 303,
          headers: { ...privateHeaders(), location: result.returnUrl },
        });
      }
      if (
        request.method === "POST" &&
        ["/v1/telegram/requests", "/v1/telegram/redeem"].includes(url.pathname)
      ) {
        const authorization = request.headers.get("authorization") ?? "";
        telegramCheck(
          authorization.startsWith("Basic ") && authorization.length < 2048,
          "telegram_broker_client_required",
          403,
        );
        let decoded: string;
        try {
          decoded = atob(authorization.slice(6));
        } catch {
          throw new TelegramError("telegram_broker_client_required", 403);
        }
        const separator = decoded.indexOf(":");
        telegramCheck(separator > 0, "telegram_broker_client_required", 403);
        const clientId = await broker.authenticate(
          decoded.slice(0, separator),
          decoded.slice(separator + 1),
        );
        if (url.pathname === "/v1/telegram/requests")
          return reply(
            await broker.request(
              clientId,
              (await readJson(request, 8192)) as BrokerRequest,
            ),
          );
        const input = fields(await readJson(request, 4096), [
          "code",
          "requestId",
          "requestDigest",
          "redemptionId",
        ]);
        return reply(
          await broker.redeem(clientId, {
            code: string(input.code),
            requestId: string(input.requestId),
            requestDigest: string(input.requestDigest),
            redemptionId: string(input.redemptionId),
          }),
        );
      }
      return reply({ error: "not_found" }, 404);
    } catch (error) {
      return failure(error);
    }
  };
}
