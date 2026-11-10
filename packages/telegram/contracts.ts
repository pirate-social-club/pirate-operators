import { digest } from "../protocol/index.ts";

export const TELEGRAM_SCHEMA = "pirate.telegram/1" as const;
export const TELEGRAM_OPEN_MS = 30 * 86400_000;
export const TELEGRAM_HISTORY_MS = 30 * 86400_000;
export const TELEGRAM_LINK_MS = 5 * 60_000;
export interface BotScope {
  communityId: string;
  botId: string;
  generation: number;
}
export interface ChatActor extends BotScope {
  userId: string;
  chatId: string;
}
export class TelegramError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function telegramCheck(
  value: unknown,
  code: string,
  status = 400,
): asserts value {
  if (!value) throw new TelegramError(code, status);
}
export function telegramId(value: unknown): string {
  telegramCheck(
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
      (typeof value === "string" &&
        /^[1-9][0-9]{0,15}$/.test(value) &&
        BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
    "telegram_identity_invalid",
  );
  return String(value);
}
export function validateScope(scope: BotScope): BotScope {
  telegramCheck(
    /^0x[0-9a-f]{64}$/.test(scope.communityId),
    "telegram_community_invalid",
  );
  telegramId(scope.botId);
  telegramCheck(
    Number.isSafeInteger(scope.generation) && scope.generation > 0,
    "telegram_generation_invalid",
  );
  return {
    communityId: scope.communityId,
    botId: scope.botId,
    generation: scope.generation,
  };
}
export function validateActor(actor: ChatActor): ChatActor {
  validateScope(actor);
  telegramCheck(
    telegramId(actor.userId) === telegramId(actor.chatId),
    "telegram_private_chat_required",
    403,
  );
  return actor;
}
export const sameScope = (a: BotScope, b: BotScope) =>
  a.communityId === b.communityId &&
  a.botId === b.botId &&
  a.generation === b.generation;
export const sameActor = (a: ChatActor, b: ChatActor) =>
  sameScope(a, b) && a.userId === b.userId && a.chatId === b.chatId;
export const actorKey = (actor: ChatActor) =>
  digest([actor.communityId, actor.botId, actor.userId]);
export const scopedKey = (scope: BotScope) =>
  digest([scope.communityId, scope.botId, scope.generation]);

export interface AccountIdentity {
  accountId: string;
  wallet: string;
  /** Changes on withdrawal/account disable; binding is checked on every use. */
  authorityVersion: string;
}
export interface WebAccount extends AccountIdentity {
  communityId: string;
  /** Server-side session identity, never a browser-supplied account identifier. */
  sessionId: string;
}
export interface TelegramAccountPort {
  /** Uses lane6 current account/withdrawal/live authorization services. Fail closed on unavailable reads. */
  current(
    communityId: string,
    accountId: string,
    wallet?: string,
  ): Promise<AccountIdentity>;
}
export interface TelegramGrant extends AccountIdentity {
  id: string;
  communityId: string;
  botId: string;
  userId: string;
  linkedAt: number;
  revokedAt: number | null;
  capabilities: readonly [
    "study",
    "progress",
    "reward-status",
    "notifications",
  ];
}
export interface BotRegistration extends BotScope {
  enabled: boolean;
}
export interface ChatBinding extends ChatActor {
  startedAt: number;
  blocked: boolean;
}
export interface NotificationPreferences {
  reminders: boolean;
  rewards: boolean;
  dance: boolean;
}
export const defaultNotifications = (): NotificationPreferences => ({
  reminders: false,
  rewards: false,
  dance: false,
});

export function accountMatches(a: AccountIdentity, b: AccountIdentity) {
  return (
    a.accountId === b.accountId &&
    a.wallet.toLowerCase() === b.wallet.toLowerCase() &&
    a.authorityVersion === b.authorityVersion
  );
}
