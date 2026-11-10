import {
  accountSession,
  authenticatedWrite,
} from "../packages/community/accounts.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  TelegramError,
  telegramCheck,
  type BotScope,
  type TelegramAccountPort,
} from "../packages/telegram/contracts.ts";
import type { TelegramWebPorts } from "./telegram-http.ts";

/** Existing community identities and MOSS bindings, never a Telegram-created
 * account/session. The integration supplies lane6's current account-status
 * check; its connectedPracticeAuthorization separately checks live learning. */
export function telegramAccountPort(options: {
  db: D1Database;
  assertAccountEnabled(accountId: string): Promise<void>;
}): TelegramAccountPort {
  return {
    async current(communityId, accountId, wallet) {
      telegramCheck(
        wallet && /^0x[0-9a-f]{40}$/.test(wallet) && !/^0x0+$/.test(wallet),
        "telegram_account_mismatch",
        403,
      );
      const row = await options.db
        .prepare(
          `SELECT b.binding_id,b.subject,s.last_withdrawn_at
        FROM credential_bindings b JOIN community_accounts a ON a.account_id=b.account_id
        JOIN application_identity i ON i.id=1 AND i.community_id=?
        LEFT JOIN learning_settings s ON s.account_id=b.account_id
        WHERE b.account_id=? AND b.namespace='moss' AND b.network=6343 AND b.subject=?`,
        )
        .bind(communityId, accountId, wallet)
        .first<{
          binding_id: string;
          subject: string;
          last_withdrawn_at: number | null;
        }>();
      telegramCheck(row, "telegram_account_mismatch", 403);
      await options.assertAccountEnabled(accountId);
      return {
        accountId,
        wallet: row.subject,
        authorityVersion: digest([
          accountId,
          row.binding_id,
          row.subject,
          row.last_withdrawn_at,
        ]),
      };
    },
  };
}
export function telegramWebAccountPorts(options: {
  db: D1Database;
  scope: BotScope;
  origin: string;
  accounts: TelegramAccountPort;
  now?: () => number;
}): TelegramWebPorts {
  const context = {
    communityId: options.scope.communityId as `0x${string}`,
    origin: options.origin,
  };
  return {
    origin: options.origin,
    scope: options.scope,
    async account(request) {
      try {
        const session = await accountSession(
          request,
          options.db,
          context,
          (options.now ?? Date.now)(),
        );
        const identity = await options.accounts.current(
          context.communityId,
          session.account_id,
          session.wallet,
        );
        return {
          ...identity,
          communityId: context.communityId,
          sessionId: session.session_hash,
        };
      } catch {
        throw new TelegramError("telegram_session_required", 401);
      }
    },
    async csrf(request, account) {
      try {
        const session = await authenticatedWrite(request, options.db, context);
        return (
          session.account_id === account.accountId &&
          session.session_hash === account.sessionId
        );
      } catch {
        return false;
      }
    },
  };
}
