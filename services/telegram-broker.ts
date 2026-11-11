import { digest } from "../packages/protocol/index.ts";
import {
  TELEGRAM_LINK_MS,
  telegramCheck,
  validateActor,
} from "../packages/telegram/contracts.ts";
import type {
  BrokerReceipt,
  BrokerRequest,
} from "../packages/telegram/link-contracts.ts";
import {
  exactReturn,
  equalSecret,
  httpsOrigin,
  randomToken,
  sha256,
} from "../packages/telegram/security.ts";
import type { TelegramJournal } from "./telegram-store.ts";
import {
  TELEGRAM_OIDC_ISSUER,
  verifyTelegramIdToken,
  type TelegramOidcProvider,
} from "./telegram-oidc.ts";

export interface TelegramBrokerClient {
  id: string;
  communityId: string;
  returnUrl: string;
  /** SHA256 base64url digest of a dedicated managed server-channel secret. */
  secretHash: string;
}
interface BrokerTransaction {
  request: BrokerRequest;
  handle: string;
  browserHash: string | null;
  state: string | null;
  verifier: string | null;
  nonce: string | null;
  phase: "created" | "started" | "exchanging" | "verified" | "refused";
  codeHash: string | null;
  completionCode: string | null;
  verifiedAt: number | null;
  receipt: BrokerReceipt | null;
}
export interface TelegramBrokerConfig {
  origin: string;
  redirectUri: string;
  oidcClientId: string;
  clients: TelegramBrokerClient[];
}
/** Independent platform-login service. Registration is a coordinator input;
 * constructing this service does not provision a domain, bot or credential. */
export class TelegramLoginBroker {
  readonly origin: string;
  readonly redirectUri: string;
  readonly store: TelegramJournal;
  readonly config: TelegramBrokerConfig;
  readonly provider: TelegramOidcProvider;
  readonly now: () => number;
  constructor(
    store: TelegramJournal,
    config: TelegramBrokerConfig,
    provider: TelegramOidcProvider,
    now = Date.now,
  ) {
    this.store = store;
    this.config = config;
    this.provider = provider;
    this.now = now;
    this.origin = httpsOrigin(config.origin);
    this.redirectUri = exactReturn(config.redirectUri);
    telegramCheck(
      new URL(this.redirectUri).origin === this.origin &&
        config.oidcClientId.length > 0,
      "telegram_broker_config_invalid",
    );
    for (const client of config.clients) exactReturn(client.returnUrl);
  }
  client(id: string) {
    const client = this.config.clients.find((value) => value.id === id);
    telegramCheck(client, "telegram_broker_client_required", 403);
    return client;
  }
  async authenticate(id: string, secret: string) {
    telegramCheck(
      await equalSecret(await sha256(secret), this.client(id).secretHash),
      "telegram_broker_client_required",
      403,
    );
    return id;
  }
  private read(id: string) {
    const transaction = this.store.get<BrokerTransaction>(`broker:${id}`);
    telegramCheck(transaction, "telegram_connection_not_found", 404);
    this.client(transaction.request.clientId);
    telegramCheck(
      transaction.request.expiresAt > this.now(),
      "telegram_connection_expired",
      410,
    );
    return transaction;
  }
  async request(clientId: string, input: BrokerRequest) {
    const client = this.client(clientId);
    validateActor(input.actor);
    telegramCheck(
      input.clientId === clientId &&
        input.actor.communityId === client.communityId &&
        input.returnUrl === client.returnUrl &&
        /^[A-Za-z0-9_-]{43}$/.test(input.id) &&
        /^[A-Za-z0-9_-]{43}$/.test(input.communityState) &&
        /^0x[0-9a-f]{64}$/.test(input.requestDigest) &&
        input.expiresAt > this.now() &&
        input.expiresAt <= this.now() + TELEGRAM_LINK_MS,
      "telegram_broker_request_invalid",
      403,
    );
    const handle = randomToken(),
      handleHash = await sha256(handle);
    const transaction = this.store.transaction(() => {
      const previous = this.store.get<BrokerTransaction>(`broker:${input.id}`);
      if (previous) {
        telegramCheck(
          digest(previous.request) === digest(input),
          "telegram_broker_request_conflict",
          409,
        );
        return previous;
      }
      const next: BrokerTransaction = {
        request: input,
        handle,
        browserHash: null,
        state: null,
        verifier: null,
        nonce: null,
        phase: "created",
        codeHash: null,
        completionCode: null,
        verifiedAt: null,
        receipt: null,
      };
      this.store.set(`broker:${input.id}`, next);
      this.store.set(`broker-handle:${handleHash}`, input.id);
      return next;
    });
    return {
      navigationUrl: `${this.origin}/telegram/oidc/start?handle=${transaction.handle}`,
    };
  }
  async begin(handle: string, browserSecret: string) {
    telegramCheck(
      /^[A-Za-z0-9_-]{43}$/.test(browserSecret),
      "telegram_browser_mismatch",
      403,
    );
    const id = this.store.get<string>(`broker-handle:${await sha256(handle)}`);
    telegramCheck(id, "telegram_connection_not_found", 404);
    const browserHash = await sha256(browserSecret),
      state = randomToken(),
      verifier = randomToken(),
      nonce = randomToken();
    const transaction = this.store.transaction(() => {
      const current = this.read(id);
      telegramCheck(
        current.phase === "created" ||
          (current.phase === "started" && current.browserHash === browserHash),
        "telegram_connection_used",
        409,
      );
      if (current.phase === "started") return current;
      const next: BrokerTransaction = {
        ...current,
        browserHash,
        state,
        verifier,
        nonce,
        phase: "started",
      };
      this.store.set(`broker:${id}`, next);
      this.store.set(`broker-state:${state}`, id);
      return next;
    });
    const url = new URL(TELEGRAM_OIDC_ISSUER + "/auth");
    for (const [key, value] of Object.entries({
      client_id: this.config.oidcClientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "openid profile",
      state: transaction.state!,
      nonce: transaction.nonce!,
      code_challenge: await sha256(transaction.verifier!),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value);
    return { authorizationUrl: url.href };
  }
  async callback(state: string, code: string, browserSecret: string) {
    telegramCheck(
      code.length > 0 && code.length <= 4096,
      "telegram_code_invalid",
      403,
    );
    const id = this.store.get<string>(`broker-state:${state}`);
    telegramCheck(id, "telegram_state_mismatch", 403);
    let transaction = this.read(id);
    telegramCheck(
      transaction.state === state &&
        transaction.browserHash === (await sha256(browserSecret)),
      "telegram_browser_mismatch",
      403,
    );
    const codeHash = await sha256(code);
    telegramCheck(
      !transaction.codeHash || transaction.codeHash === codeHash,
      "telegram_code_changed",
      403,
    );
    let dispatch = false;
    transaction = this.store.transaction(() => {
      const current = this.read(id);
      telegramCheck(
        current.phase !== "refused",
        "telegram_provider_refused",
        403,
      );
      if (current.phase === "started") {
        dispatch = true;
        const next: BrokerTransaction = {
          ...current,
          phase: "exchanging",
          codeHash,
        };
        this.store.set(`broker:${id}`, next);
        return next;
      }
      telegramCheck(
        current.codeHash === codeHash,
        "telegram_code_changed",
        403,
      );
      return current;
    });
    if (transaction.phase !== "verified") {
      // Unknown exchange outcomes are recovered by receipt only, never by a
      // second exchange with the same authorization code.
      const token = dispatch
        ? await this.provider.exchange({
            requestId: id,
            code,
            verifier: transaction.verifier!,
            redirectUri: this.redirectUri,
          })
        : await this.provider.recover?.(id);
      telegramCheck(token, "telegram_exchange_pending", 409);
      let verified: { telegramId: string; verifiedAt: number };
      try {
        verified = await verifyTelegramIdToken({
          token,
          clientId: this.config.oidcClientId,
          nonce: transaction.nonce!,
          now: this.now(),
          keys: await this.provider.jwks(),
        });
        telegramCheck(
          verified.telegramId === transaction.request.actor.userId,
          "telegram_sender_mismatch",
          403,
        );
      } catch (error) {
        this.store.set(`broker:${id}`, {
          ...this.read(id),
          phase: "refused",
          verifier: null,
          nonce: null,
        });
        throw error;
      }
      const completionCode = randomToken(),
        completionHash = await sha256(completionCode);
      transaction = this.store.transaction(() => {
        const current = this.read(id);
        if (current.phase === "verified") return current;
        telegramCheck(
          current.phase === "exchanging" && current.codeHash === codeHash,
          "telegram_connection_used",
          409,
        );
        const next: BrokerTransaction = {
          ...current,
          phase: "verified",
          completionCode,
          verifiedAt: verified.verifiedAt,
          verifier: null,
          nonce: null,
        };
        this.store.set(`broker:${id}`, next);
        this.store.set(`broker-completion:${completionHash}`, id);
        return next;
      });
    }
    telegramCheck(
      transaction.completionCode && !transaction.receipt,
      "telegram_connection_used",
      409,
    );
    const url = new URL(transaction.request.returnUrl);
    url.searchParams.set("transactionId", id);
    url.searchParams.set("state", transaction.request.communityState);
    url.searchParams.set("code", transaction.completionCode);
    return { returnUrl: url.href };
  }
  async redeem(
    clientId: string,
    input: {
      code: string;
      requestId: string;
      requestDigest: string;
      redemptionId: string;
    },
  ): Promise<BrokerReceipt> {
    this.client(clientId);
    const id = this.store.get<string>(
      `broker-completion:${await sha256(input.code)}`,
    );
    telegramCheck(id === input.requestId, "telegram_redemption_mismatch", 403);
    return this.store.transaction(() => {
      const current = this.read(input.requestId),
        request = current.request;
      telegramCheck(
        current.phase === "verified" &&
          request.clientId === clientId &&
          request.requestDigest === input.requestDigest &&
          /^[A-Za-z0-9_-]{43}$/.test(input.redemptionId),
        "telegram_redemption_mismatch",
        403,
      );
      if (current.receipt) {
        telegramCheck(
          current.receipt.redemptionId === input.redemptionId,
          "telegram_redemption_used",
          409,
        );
        return current.receipt;
      }
      const receipt: BrokerReceipt = {
        requestId: request.id,
        requestDigest: request.requestDigest,
        clientId,
        redemptionId: input.redemptionId,
        actor: request.actor,
        telegramId: request.actor.userId,
        verifiedAt: current.verifiedAt!,
      };
      this.store.set(`broker:${id}`, {
        ...current,
        completionCode: null,
        receipt,
      });
      return receipt;
    });
  }
}
