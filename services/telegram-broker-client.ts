import {
  TelegramError,
  telegramCheck,
} from "../packages/telegram/contracts.ts";
import type {
  BrokerReceipt,
  TelegramBrokerPort,
} from "../packages/telegram/link-contracts.ts";
import { httpsOrigin, readJson } from "../packages/telegram/security.ts";

/** Server-only adapter. No token, secret or client authentication reaches the
 * browser. Fetch is supplied explicitly, including in all local simulations. */
export function telegramBrokerClient(
  config: { origin: string; clientId: string; clientSecret: string },
  transport: typeof fetch,
): TelegramBrokerPort {
  const origin = httpsOrigin(config.origin);
  async function call<T>(path: string, input: unknown): Promise<T> {
    const response = await transport(origin + path, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        authorization:
          "Basic " + btoa(config.clientId + ":" + config.clientSecret),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
    const value = (await readJson(response, 16_384)) as { error?: string };
    if (!response.ok)
      throw new TelegramError(
        value.error ?? "telegram_broker_unavailable",
        response.status,
      );
    return value as T;
  }
  return {
    async request(input) {
      telegramCheck(
        input.clientId === config.clientId,
        "telegram_broker_client_required",
        403,
      );
      const result = await call<{ navigationUrl: string }>(
        "/v1/telegram/requests",
        input,
      );
      const url = new URL(result.navigationUrl);
      telegramCheck(
        url.origin === origin && url.pathname === "/telegram/oidc/start",
        "telegram_broker_response_invalid",
        503,
      );
      return result;
    },
    redeem: (input) => call<BrokerReceipt>("/v1/telegram/redeem", input),
  };
}
