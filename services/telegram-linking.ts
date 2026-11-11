import { digest } from "../packages/protocol/index.ts";
import {
  TELEGRAM_LINK_MS,
  accountMatches,
  sameActor,
  telegramCheck,
  validateActor,
  type BotScope,
  type ChatActor,
  type WebAccount,
} from "../packages/telegram/contracts.ts";
import type {
  BrokerRequest,
  CommunityLinkTransaction,
  PendingConnection,
  TelegramBrokerPort,
} from "../packages/telegram/link-contracts.ts";
import {
  exactReturn,
  randomToken,
  sha256,
} from "../packages/telegram/security.ts";
import { TelegramGrants } from "./telegram-grants.ts";

/** A navigation reference is never proof of either identity. */
export class TelegramLinking {
  readonly returnUrl: string;
  readonly grants: TelegramGrants;
  readonly broker: TelegramBrokerPort;
  readonly clientId: string;
  constructor(
    grants: TelegramGrants,
    broker: TelegramBrokerPort,
    clientId: string,
    returnUrl: string,
  ) {
    this.grants = grants;
    this.broker = broker;
    this.clientId = clientId;
    this.returnUrl = exactReturn(returnUrl);
  }
  async pending(actor: ChatActor) {
    validateActor(actor);
    this.grants.binding(actor);
    const reference = randomToken();
    const hash = await sha256(reference);
    this.grants.binding(actor);
    this.grants.store.set(`pending:${hash}`, {
      actor,
      expiresAt: this.grants.now() + TELEGRAM_LINK_MS,
      consumedBy: null,
    } satisfies PendingConnection);
    return reference;
  }
  async create(reference: string, account: WebAccount, browserSecret: string) {
    telegramCheck(
      /^[A-Za-z0-9_-]{43}$/.test(browserSecret),
      "telegram_browser_mismatch",
      403,
    );
    const pendingHash = await sha256(reference),
      key = `pending:${pendingHash}`;
    const pending = this.grants.store.get<PendingConnection>(key);
    telegramCheck(
      pending && pending.expiresAt > this.grants.now(),
      "telegram_connection_expired",
      410,
    );
    telegramCheck(
      account.communityId === pending.actor.communityId &&
        account.sessionId.length > 0,
      "telegram_account_mismatch",
      403,
    );
    this.grants.current(pending.actor);
    this.grants.senderReady(pending.actor);
    this.grants.accountReady(pending.actor, account.accountId);
    const current = await this.grants.accounts.current(
      account.communityId,
      account.accountId,
      account.wallet,
    );
    telegramCheck(
      accountMatches(current, account),
      "telegram_account_mismatch",
      403,
    );
    this.grants.senderReady(pending.actor);
    this.grants.accountReady(pending.actor, account.accountId);
    const browserHash = await sha256(browserSecret);
    return this.grants.store.transaction(() => {
      this.grants.current(pending.actor);
      this.grants.senderReady(pending.actor);
      this.grants.accountReady(pending.actor, account.accountId);
      const live = this.grants.store.get<PendingConnection>(key);
      telegramCheck(
        live && live.expiresAt > this.grants.now() && !live.consumedBy,
        "telegram_connection_used",
        409,
      );
      const id = randomToken(),
        communityState = randomToken();
      const requestDigest = digest({
        id,
        actor: pending.actor,
        account,
        browserHash,
        returnUrl: this.returnUrl,
        communityState,
      });
      const transaction: CommunityLinkTransaction = {
        id,
        pendingHash,
        actor: pending.actor,
        account,
        browserHash,
        communityState,
        requestDigest,
        expiresAt: Math.min(
          pending.expiresAt,
          this.grants.now() + TELEGRAM_LINK_MS,
        ),
        phase: "created",
        navigationUrl: null,
        redemptionId: randomToken(),
        completionHash: null,
        grant: null,
        fence: this.grants.linkFence(pending.actor, account.accountId),
      };
      this.grants.store.set(key, { ...live, consumedBy: id });
      this.grants.store.set(`link:${id}`, transaction);
      return transaction;
    });
  }
  private async bound(id: string, account: WebAccount, browserSecret: string) {
    const transaction = this.grants.store.get<CommunityLinkTransaction>(
      `link:${id}`,
    );
    telegramCheck(transaction, "telegram_connection_not_found", 404);
    telegramCheck(
      transaction.expiresAt > this.grants.now(),
      "telegram_connection_expired",
      410,
    );
    this.grants.current(transaction.actor);
    this.grants.senderReady(transaction.actor);
    this.grants.accountReady(transaction.actor, transaction.account.accountId);
    telegramCheck(
      account.communityId === transaction.account.communityId &&
        account.sessionId === transaction.account.sessionId &&
        accountMatches(account, transaction.account),
      "telegram_account_mismatch",
      403,
    );
    telegramCheck(
      (await sha256(browserSecret)) === transaction.browserHash,
      "telegram_browser_mismatch",
      403,
    );
    this.grants.senderReady(transaction.actor);
    this.grants.accountReady(transaction.actor, transaction.account.accountId);
    const current = await this.grants.accounts.current(
      account.communityId,
      account.accountId,
      account.wallet,
    );
    telegramCheck(
      accountMatches(current, transaction.account),
      "telegram_authority_changed",
      403,
    );
    this.grants.current(transaction.actor);
    this.grants.checkLinkFence(
      transaction.actor,
      transaction.account.accountId,
      transaction.fence,
    );
    return transaction;
  }
  async open(id: string, account: WebAccount, browserSecret: string) {
    const transaction = await this.bound(id, account, browserSecret);
    telegramCheck(
      transaction.phase === "created" || transaction.phase === "broker_ready",
      "telegram_connection_used",
      409,
    );
    const input: BrokerRequest = {
      id,
      clientId: this.clientId,
      requestDigest: transaction.requestDigest,
      actor: transaction.actor,
      returnUrl: this.returnUrl,
      communityState: transaction.communityState,
      expiresAt: transaction.expiresAt,
    };
    const result = await this.broker.request(input);
    await this.bound(id, account, browserSecret);
    this.grants.store.transaction(() => {
      const current = this.grants.store.get<CommunityLinkTransaction>(
        `link:${id}`,
      )!;
      this.grants.current(current.actor);
      this.grants.checkLinkFence(
        current.actor,
        current.account.accountId,
        current.fence,
      );
      telegramCheck(
        current.phase === "created" || current.phase === "broker_ready",
        "telegram_connection_used",
        409,
      );
      this.grants.store.set(`link:${id}`, {
        ...current,
        phase: "broker_ready",
        navigationUrl: result.navigationUrl,
      });
    });
    return { transactionId: id, navigationUrl: result.navigationUrl };
  }
  /** GET return is a read-only projection. Only the authenticated completion POST below links. */
  async inspect(
    id: string,
    state: string,
    account: WebAccount,
    browserSecret: string,
  ) {
    const transaction = await this.bound(id, account, browserSecret);
    telegramCheck(
      state === transaction.communityState,
      "telegram_state_mismatch",
      403,
    );
    return { transactionId: id, state: transaction.phase };
  }
  async complete(
    id: string,
    state: string,
    code: string,
    account: WebAccount,
    browserSecret: string,
  ) {
    let transaction = await this.bound(id, account, browserSecret);
    telegramCheck(
      transaction.communityState === state,
      "telegram_state_mismatch",
      403,
    );
    const completionHash = await sha256(code);
    telegramCheck(
      transaction.phase !== "created",
      "telegram_connection_not_ready",
      409,
    );
    if (transaction.phase === "complete") {
      telegramCheck(
        transaction.completionHash === completionHash,
        "telegram_completion_changed",
        409,
      );
      return this.grants.assert(transaction.actor, transaction.grant!.id);
    }
    transaction = this.grants.store.transaction(() => {
      const current = this.grants.store.get<CommunityLinkTransaction>(
        `link:${id}`,
      )!;
      this.grants.current(current.actor);
      this.grants.checkLinkFence(
        current.actor,
        current.account.accountId,
        current.fence,
      );
      telegramCheck(
        current.phase === "broker_ready" ||
          current.phase === "redeeming" ||
          current.phase === "complete",
        "telegram_connection_not_ready",
        409,
      );
      telegramCheck(
        !current.completionHash || current.completionHash === completionHash,
        "telegram_completion_changed",
        409,
      );
      if (current.phase === "complete") return current;
      const next: CommunityLinkTransaction = {
        ...current,
        completionHash,
        phase: "redeeming",
      };
      this.grants.store.set(`link:${id}`, next);
      return next;
    });
    if (transaction.phase === "complete") {
      return this.grants.assert(transaction.actor, transaction.grant!.id);
    }
    const receipt = await this.broker.redeem({
      code,
      requestId: id,
      requestDigest: transaction.requestDigest,
      redemptionId: transaction.redemptionId,
    });
    await this.bound(id, account, browserSecret);
    telegramCheck(
      receipt.clientId === this.clientId &&
        receipt.requestId === id &&
        receipt.requestDigest === transaction.requestDigest &&
        receipt.redemptionId === transaction.redemptionId &&
        sameActor(receipt.actor, transaction.actor) &&
        receipt.telegramId === transaction.actor.userId &&
        receipt.verifiedAt <= this.grants.now() &&
        receipt.verifiedAt >= transaction.expiresAt - TELEGRAM_LINK_MS,
      "telegram_redemption_mismatch",
      403,
    );
    return this.grants.store.transaction(() => {
      const current = this.grants.store.get<CommunityLinkTransaction>(
        `link:${id}`,
      )!;
      this.grants.current(current.actor);
      this.grants.checkLinkFence(
        current.actor,
        current.account.accountId,
        current.fence,
      );
      telegramCheck(
        current.phase === "redeeming" || current.phase === "complete",
        "telegram_connection_used",
        409,
      );
      if (current.phase === "complete") {
        const existing = this.grants.read(transaction.actor);
        telegramCheck(
          existing?.id === current.grant?.id && existing?.revokedAt === null,
          "telegram_connection_required",
          403,
        );
        return existing;
      }
      const grant = this.grants.commit(
        transaction.actor,
        transaction.account,
        id,
        current.fence,
      );
      this.grants.store.set(`link:${id}`, {
        ...current,
        phase: "complete",
        grant,
      });
      return grant;
    });
  }
  connection(scope: BotScope, accountId: string) {
    return this.grants.forAccount(scope, accountId);
  }
}
