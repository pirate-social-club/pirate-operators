import {
  accountMatches,
  actorKey,
  defaultNotifications,
  sameScope,
  telegramCheck,
  validateActor,
  validateScope,
  type AccountIdentity,
  type BotRegistration,
  type BotScope,
  type ChatActor,
  type ChatBinding,
  type NotificationPreferences,
  type TelegramAccountPort,
  type TelegramGrant,
  type TelegramLinkFence,
} from "../packages/telegram/contracts.ts";
import { randomToken } from "../packages/telegram/security.ts";
import type { TelegramJournal } from "./telegram-store.ts";

export class TelegramGrants {
  readonly store: TelegramJournal;
  readonly accounts: TelegramAccountPort;
  readonly now: () => number;
  constructor(
    store: TelegramJournal,
    accounts: TelegramAccountPort,
    now = Date.now,
  ) {
    this.store = store;
    this.accounts = accounts;
    this.now = now;
  }
  configure(next: BotRegistration) {
    validateScope(next);
    return this.store.transaction(() => {
      const key = `bot:${next.communityId}`,
        old = this.store.get<BotRegistration>(key);
      // Unversioned legacy state cannot prove that this bot was never replaced
      // and restored under the old partial scan. Require migration evidence;
      // never silently bless an omitted legacy grant as the current lineage.
      telegramCheck(
        !old || this.store.get(`bot-lineage:${next.communityId}`),
        "telegram_lineage_migration_required",
        503,
      );
      if (!old)
        this.store.set(`bot-lineage:${next.communityId}`, {
          incarnation: 0,
          replacedAt: 0,
        });
      if (old) {
        telegramCheck(
          next.generation >= old.generation,
          "telegram_generation_stale",
          409,
        );
        telegramCheck(
          next.generation !== old.generation || next.botId === old.botId,
          "telegram_bot_change_requires_generation",
          409,
        );
        if (old.botId !== next.botId) {
          const lineage = this.lineage(next.communityId);
          this.store.set(`bot-lineage:${next.communityId}`, {
            incarnation: lineage.incarnation + 1,
            replacedAt: this.now(),
          });
        }
      }
      this.store.set(key, next);
      return next;
    });
  }
  private lineage(communityId: string) {
    return (
      this.store.get<{ incarnation: number; replacedAt: number }>(
        `bot-lineage:${communityId}`,
      ) ?? { incarnation: 0, replacedAt: 0 }
    );
  }
  private effective(grant: TelegramGrant | undefined) {
    if (!grant) return grant;
    const lineage = this.lineage(grant.communityId);
    return (grant.incarnation ?? 0) === lineage.incarnation
      ? grant
      : { ...grant, revokedAt: grant.revokedAt ?? lineage.replacedAt };
  }
  linkFence(actor: ChatActor, accountId: string): TelegramLinkFence {
    return {
      incarnation: this.lineage(actor.communityId).incarnation,
      userUnlink: this.store.get<number>(`unlink-user:${actorKey(actor)}`) ?? 0,
      accountUnlink:
        this.store.get<number>(
          `unlink-account:${actor.communityId}:${actor.botId}:${accountId}`,
        ) ?? 0,
    };
  }
  checkLinkFence(
    actor: ChatActor,
    accountId: string,
    expected: TelegramLinkFence,
  ) {
    const current = this.linkFence(actor, accountId);
    telegramCheck(
      expected &&
        current.incarnation === expected.incarnation &&
        current.userUnlink === expected.userUnlink &&
        current.accountUnlink === expected.accountUnlink,
      "telegram_link_revoked",
      403,
    );
  }
  current(scope: BotScope) {
    validateScope(scope);
    telegramCheck(
      this.store.get(`bot-lineage:${scope.communityId}`),
      "telegram_lineage_migration_required",
      503,
    );
    const current = this.store.get<BotRegistration>(`bot:${scope.communityId}`);
    telegramCheck(
      current?.enabled && sameScope(current, scope),
      "telegram_bot_changed",
      409,
    );
    return current;
  }
  start(actor: ChatActor) {
    validateActor(actor);
    this.current(actor);
    this.store.set(`chat:${actorKey(actor)}`, {
      ...actor,
      startedAt: this.now(),
      blocked: false,
    } satisfies ChatBinding);
  }
  binding(actor: ChatActor) {
    this.current(actor);
    const binding = this.store.get<ChatBinding>(`chat:${actorKey(actor)}`);
    telegramCheck(
      binding &&
        sameScope(binding, actor) &&
        binding.chatId === actor.chatId &&
        !binding.blocked,
      "telegram_start_required",
      403,
    );
    return binding;
  }
  block(actor: ChatActor) {
    const key = `chat:${actorKey(actor)}`,
      binding = this.store.get<ChatBinding>(key);
    if (binding && sameScope(binding, actor))
      this.store.set(key, { ...binding, blocked: true });
  }
  read(actor: ChatActor) {
    return this.effective(
      this.store.get<TelegramGrant>(
        `grant:${actor.communityId}:${actor.botId}:${actor.userId}`,
      ),
    );
  }
  async assert(actor: ChatActor, grantId?: string): Promise<TelegramGrant> {
    this.binding(actor);
    const grant = this.read(actor);
    telegramCheck(
      grant && grant.revokedAt === null && (!grantId || grant.id === grantId),
      "telegram_connection_required",
      403,
    );
    const account = await this.accounts.current(
      actor.communityId,
      grant.accountId,
      grant.wallet,
    );
    this.binding(actor);
    const again = this.read(actor);
    telegramCheck(
      again?.id === grant.id &&
        again.revokedAt === null &&
        grant.accountId === account.accountId &&
        grant.wallet.toLowerCase() === account.wallet.toLowerCase(),
      "telegram_authority_changed",
      403,
    );
    // Browser sessions and publication sign-ins can change while the identity
    // association survives. Queued work captures this fresh authority version
    // and must check it again; the grant itself does not periodically expire.
    return { ...grant, authorityVersion: account.authorityVersion };
  }
  /** Called only after independently verified Telegram identity and account-bound redemption. */
  commit(
    actor: ChatActor,
    account: AccountIdentity,
    transactionId: string,
    fence: TelegramLinkFence,
  ): TelegramGrant {
    return this.store.transaction(() => {
      this.current(actor);
      this.checkLinkFence(actor, account.accountId, fence);
      const key = `grant:${actor.communityId}:${actor.botId}:${actor.userId}`;
      const index = `account-grant:${actor.communityId}:${actor.botId}:${account.accountId}`;
      const previous = this.effective(this.store.get<TelegramGrant>(key));
      if (previous?.revokedAt === null) {
        telegramCheck(
          previous.accountId === account.accountId &&
            previous.wallet.toLowerCase() === account.wallet.toLowerCase(),
          "telegram_link_conflict",
          409,
        );
        return previous;
      }
      const otherKey = this.store.get<string>(index),
        other = this.effective(
          otherKey ? this.store.get<TelegramGrant>(otherKey) : undefined,
        );
      telegramCheck(
        !other || other.revokedAt !== null || other.userId === actor.userId,
        "telegram_link_conflict",
        409,
      );
      const grant: TelegramGrant = {
        ...account,
        id: transactionId,
        communityId: actor.communityId,
        botId: actor.botId,
        userId: actor.userId,
        linkedAt: this.now(),
        revokedAt: null,
        incarnation: fence.incarnation,
        capabilities: ["study", "progress", "reward-status", "notifications"],
      };
      this.store.set(key, grant);
      this.store.set(index, key);
      return grant;
    });
  }
  forAccount(scope: BotScope, accountId: string) {
    validateScope(scope);
    telegramCheck(
      this.store.get(`bot-lineage:${scope.communityId}`),
      "telegram_lineage_migration_required",
      503,
    );
    const registration = this.store.get<BotRegistration>(
      `bot:${scope.communityId}`,
    );
    telegramCheck(
      registration && sameScope(registration, scope),
      "telegram_bot_changed",
      409,
    );
    const key = this.store.get<string>(
      `account-grant:${scope.communityId}:${scope.botId}:${accountId}`,
    );
    const grant = this.effective(
      key ? this.store.get<TelegramGrant>(key) : undefined,
    );
    return grant?.revokedAt === null ? grant : null;
  }
  unlink(scope: BotScope, accountId: string) {
    return this.store.transaction(() => {
      const grant = this.forAccount(scope, accountId);
      const accountFence = `unlink-account:${scope.communityId}:${scope.botId}:${accountId}`;
      this.store.set(
        accountFence,
        (this.store.get<number>(accountFence) ?? 0) + 1,
      );
      if (!grant) return false;
      const userFence = `unlink-user:${actorKey({ ...scope, userId: grant.userId, chatId: grant.userId })}`;
      this.store.set(userFence, (this.store.get<number>(userFence) ?? 0) + 1);
      this.store.set(
        `grant:${grant.communityId}:${grant.botId}:${grant.userId}`,
        { ...grant, revokedAt: this.now() },
      );
      return true;
    });
  }
  preferences(actor: ChatActor): NotificationPreferences {
    return (
      this.store.get<NotificationPreferences>(
        `preferences:${actorKey(actor)}`,
      ) ?? defaultNotifications()
    );
  }
  setPreferences(actor: ChatActor, value: NotificationPreferences) {
    this.binding(actor);
    return this.savePreferences(actor, value);
  }
  setAccountPreferences(
    scope: BotScope,
    accountId: string,
    value: NotificationPreferences,
  ) {
    const grant = this.forAccount(scope, accountId);
    telegramCheck(grant, "telegram_connection_required", 403);
    return this.savePreferences(
      { ...scope, userId: grant.userId, chatId: grant.userId },
      value,
    );
  }
  private savePreferences(actor: ChatActor, value: NotificationPreferences) {
    telegramCheck(
      value && typeof value === "object",
      "telegram_preferences_invalid",
    );
    telegramCheck(
      Object.keys(value).sort().join() === "dance,reminders,rewards" &&
        Object.values(value).every((v) => typeof v === "boolean"),
      "telegram_preferences_invalid",
    );
    this.store.set(`preferences:${actorKey(actor)}`, value);
    return value;
  }
  requestId() {
    return randomToken();
  }
}
