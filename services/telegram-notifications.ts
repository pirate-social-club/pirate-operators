import { digest } from "../packages/protocol/index.ts";
import {
  actorKey,
  telegramCheck,
  type BotScope,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import type { TelegramBotViews } from "./telegram-bot-view.ts";
import type { TelegramGrants } from "./telegram-grants.ts";
import type { TelegramOutbox } from "./telegram-outbox.ts";

export interface TelegramAccountNotice {
  communityId: string;
  accountId: string;
  eventId: string;
  kind: "claim_ready" | "dance_reviewed";
  current: boolean;
  path: string;
}
export interface TelegramNoticePort {
  /** Current ledger/review projection, authenticated on the server. A webhook
   * message, Telegram admin flag or widget query cannot supply these facts. */
  read(
    communityId: string,
    accountId: string,
    kind: TelegramAccountNotice["kind"],
    eventId: string,
  ): Promise<TelegramAccountNotice>;
}
export interface TelegramNoticeGuard {
  kind: "reminder" | "claim_ready" | "dance_reviewed";
  accountId: string | null;
  eventId: string;
}
export async function telegramNoticePermitted(
  grants: TelegramGrants,
  notices: TelegramNoticePort,
  actor: ChatActor,
  guard: TelegramNoticeGuard,
) {
  const prefs = grants.preferences(actor);
  telegramCheck(
    guard.kind === "reminder"
      ? prefs.reminders
      : guard.kind === "claim_ready"
        ? prefs.rewards
        : prefs.dance,
    "telegram_notifications_disabled",
    403,
  );
  if (guard.kind === "reminder") return;
  const grant = await grants.assert(actor);
  telegramCheck(
    grant.accountId === guard.accountId,
    "telegram_notice_wrong_account",
    403,
  );
  const current = await notices.read(
    actor.communityId,
    grant.accountId,
    guard.kind,
    guard.eventId,
  );
  telegramCheck(
    current.current &&
      current.communityId === actor.communityId &&
      current.accountId === grant.accountId &&
      current.eventId === guard.eventId &&
      current.kind === guard.kind,
    "telegram_notice_stale",
    409,
  );
}
export class TelegramNotifications {
  readonly views: TelegramBotViews;
  readonly outbox: TelegramOutbox;
  readonly notices: TelegramNoticePort;
  constructor(
    views: TelegramBotViews,
    outbox: TelegramOutbox,
    notices: TelegramNoticePort,
  ) {
    this.views = views;
    this.outbox = outbox;
    this.notices = notices;
  }
  async account(
    scope: BotScope,
    accountId: string,
    kind: TelegramAccountNotice["kind"],
    eventId: string,
  ) {
    const grants = this.views.linking.grants,
      grant = grants.forAccount(scope, accountId);
    if (!grant) return false;
    const actor = { ...scope, userId: grant.userId, chatId: grant.userId },
      fresh = await grants.assert(actor, grant.id);
    const notice: TelegramNoticeGuard = { kind, accountId, eventId };
    await telegramNoticePermitted(grants, this.notices, actor, notice);
    const facts = await this.notices.read(
      scope.communityId,
      accountId,
      kind,
      eventId,
    );
    telegramCheck(
      facts.path.startsWith("/#") &&
        !facts.path.includes("\\") &&
        facts.path.length <= 512,
      "telegram_notice_path_invalid",
    );
    const id = digest([
      scope.communityId,
      scope.botId,
      grant.id,
      kind,
      eventId,
    ]);
    if (grants.store.get(`notice:${id}`)) return true;
    grants.store.transaction(() => {
      if (grants.store.get(`notice:${id}`)) return;
      this.outbox.enqueue(
        actor,
        `notice:${id}`,
        {
          kind: "text",
          text:
            kind === "claim_ready"
              ? "A claim is available."
              : "Your Dance review is ready.",
          buttons: [
            [
              {
                text: "Continue on website",
                url: this.views.origin + facts.path,
              },
            ],
          ],
        },
        { grantId: grant.id, authorityVersion: fresh.authorityVersion, notice },
      );
      grants.store.set(`notice:${id}`, { at: grants.now(), accountId, kind });
    });
    return true;
  }
  async reminder(actor: ChatActor, eventId: string) {
    const grants = this.views.linking.grants;
    grants.binding(actor);
    const notice: TelegramNoticeGuard = {
      kind: "reminder",
      accountId: null,
      eventId,
    };
    await telegramNoticePermitted(grants, this.notices, actor, notice);
    const remembered = grants.read(actor),
      grant =
        remembered?.revokedAt === null
          ? await grants.assert(actor, remembered.id)
          : null;
    const { songs } = await this.views.catalog.list(actor, grant),
      song = songs.find((song) => (song.streak ?? 0) > 0) ?? songs[0];
    const id = digest([actor, eventId, "reminder"]);
    if (grants.store.get(`notice:${id}`)) return;
    const button = this.views.button(
      actor,
      song ? `Continue ${song.title}` : "Songs",
      song ? { kind: "song", key: song.key } : { kind: "songs", page: 0 },
    );
    grants.store.transaction(() => {
      if (grants.store.get(`notice:${id}`)) return;
      this.outbox.enqueue(
        actor,
        `reminder:${id}`,
        {
          kind: "text",
          text:
            grant && song?.streak
              ? `Keep your ${song.streak} day streak going.`
              : "Ready to practise?",
          buttons: [[button]],
        },
        {
          ...(grant
            ? { grantId: grant.id, authorityVersion: grant.authorityVersion }
            : {}),
          notice,
        },
      );
      grants.store.set(`notice:${id}`, {
        at: grants.now(),
        actor: actorKey(actor),
        kind: "reminder",
      });
    });
  }
}
