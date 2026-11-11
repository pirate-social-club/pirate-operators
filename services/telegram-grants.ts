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

interface PublicationScopeChange {
  from: BotRegistration;
  to: BotRegistration;
}
const registrationMatches = (a: BotRegistration, b: BotRegistration) =>
  sameScope(a, b) && a.enabled === b.enabled;
const publicationScopeChangeKey = (communityId: string) =>
  `bot-publication-change:${communityId}`;
const managedScopeKey = (communityId: string) =>
  `bot-publication-managed:${communityId}`;

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
  private registration(next: BotRegistration): BotRegistration {
    telegramCheck(typeof next.enabled === "boolean", "telegram_bot_invalid");
    return { ...validateScope(next), enabled: next.enabled };
  }
  private previous(next: BotRegistration) {
    const old = this.store.get<BotRegistration>(`bot:${next.communityId}`);
    // Legacy state without an explicit lineage cannot be trusted to exclude
    // grants from a bot that was replaced and later restored.
    telegramCheck(
      !old || this.store.get(`bot-lineage:${next.communityId}`),
      "telegram_lineage_migration_required",
      503,
    );
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
    }
    return old;
  }
  private saveRegistration(next: BotRegistration, old?: BotRegistration) {
    if (!old)
      this.store.set(`bot-lineage:${next.communityId}`, {
        incarnation: 0,
        replacedAt: 0,
      });
    else if (old.botId !== next.botId) {
      const lineage = this.lineage(next.communityId);
      this.store.set(`bot-lineage:${next.communityId}`, {
        incarnation: lineage.incarnation + 1,
        replacedAt: this.now(),
      });
    }
    this.store.set(`bot:${next.communityId}`, next);
    return next;
  }
  configure(value: BotRegistration) {
    const next = this.registration(value);
    return this.store.transaction(() => {
      const old = this.previous(next);
      if (this.store.get(managedScopeKey(next.communityId))) {
        telegramCheck(
          old &&
            registrationMatches(old, next) &&
            !this.store.get(publicationScopeChangeKey(next.communityId)),
          "telegram_publication_scope_managed",
          409,
        );
        return old;
      }
      return this.saveRegistration(next, old);
    });
  }
  stagePublicationScope(value: BotRegistration) {
    const next = this.registration(value);
    return this.store.transaction(() => {
      const old = this.previous(next);
      const key = publicationScopeChangeKey(next.communityId);
      const pending = this.store.get<PublicationScopeChange>(key);
      if (pending) {
        telegramCheck(
          old &&
            registrationMatches(old, pending.from) &&
            registrationMatches(next, pending.to),
          "telegram_publication_scope_pending",
          409,
        );
        return { registration: next, pending };
      }
      telegramCheck(
        !old ||
          old.enabled ||
          !next.enabled ||
          next.generation > old.generation,
        "telegram_reenable_requires_generation",
        409,
      );
      this.store.set(managedScopeKey(next.communityId), true);
      if (!old || registrationMatches(old, next))
        return { registration: this.saveRegistration(next, old), pending: null };
      const change = { from: this.registration(old), to: next };
      this.store.set(key, change);
      return { registration: next, pending: change };
    });
  }
  finishPublicationScope(change: PublicationScopeChange) {
    return this.store.transaction(() => {
      const key = publicationScopeChangeKey(change.to.communityId);
      const old = this.previous(change.to);
      const pending = this.store.get<PublicationScopeChange>(key);
      // Exact duplicate acknowledgments can arrive after a completed retry.
      if (!pending && old && registrationMatches(old, change.to)) return old;
      telegramCheck(
        old &&
          pending &&
          registrationMatches(old, change.from) &&
          registrationMatches(pending.from, change.from) &&
          registrationMatches(pending.to, change.to),
        "telegram_publication_scope_changed",
        409,
      );
      const next = this.saveRegistration(pending.to, old);
      this.store.delete(key);
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
    telegramCheck(
      !this.store.get(publicationScopeChangeKey(scope.communityId)),
      "telegram_publication_scope_pending",
      409,
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
  private accountIndex(scope: BotScope, accountId: string) {
    return `account-grant:${scope.communityId}:${scope.botId}:${accountId}`;
  }
  private retireAccountIndex(index: string, expectedRow: string) {
    if (this.store.get<string>(index) === expectedRow) this.store.delete(index);
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
      const index = this.accountIndex(actor, account.accountId);
      const previous = this.effective(this.store.get<TelegramGrant>(key));
      const other = this.forAccount(actor, account.accountId);
      telegramCheck(
        !other || other.userId === actor.userId,
        "telegram_link_conflict",
        409,
      );
      if (previous?.revokedAt === null) {
        telegramCheck(
          previous.accountId === account.accountId &&
            previous.wallet.toLowerCase() === account.wallet.toLowerCase(),
          "telegram_link_conflict",
          409,
        );
        this.store.set(index, key);
        return previous;
      }
      // A reused sender row must not remain addressable through its former
      // account. Do not remove a pointer that now belongs to another sender.
      if (previous)
        this.retireAccountIndex(
          this.accountIndex(actor, previous.accountId),
          key,
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
    return this.store.transaction(() => {
      const index = this.accountIndex(scope, accountId);
      const key = this.store.get<string>(index);
      if (!key) return null;
      const grant = this.effective(this.store.get<TelegramGrant>(key));
      if (
        grant?.revokedAt === null &&
        grant.accountId === accountId &&
        grant.communityId === scope.communityId &&
        grant.botId === scope.botId &&
        key === `grant:${scope.communityId}:${scope.botId}:${grant.userId}`
      )
        return grant;
      // Legacy stale index repair is lazy and bounded; the row it referenced
      // may belong to a different live account and must never be changed.
      this.retireAccountIndex(index, key);
      return null;
    });
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
      const row = `grant:${grant.communityId}:${grant.botId}:${grant.userId}`;
      this.store.set(row, { ...grant, revokedAt: this.now() });
      this.retireAccountIndex(this.accountIndex(scope, accountId), row);
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
