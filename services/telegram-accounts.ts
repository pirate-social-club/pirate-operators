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
  /** Coordinator-owned durable epoch and pending transition state. */
  authorityState(accountId: string): Promise<{
    revision: string;
    pending: boolean;
    permissionRevision: string;
  }>;
}): TelegramAccountPort {
  return {
    async current(communityId, accountId, wallet) {
      telegramCheck(
        wallet && /^0x[0-9a-f]{40}$/.test(wallet) && !/^0x0+$/.test(wallet),
        "telegram_account_mismatch",
        403,
      );
      const before = await options.authorityState(accountId);
      telegramCheck(
        before &&
          typeof before.revision === "string" &&
          before.revision.length > 0 &&
          before.pending === false,
        "telegram_publication_pending",
        503,
      );
      const read = () =>
        options.db
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
          }>()
          // SQLite adapters may return null-prototype rows. Canonical hashes
          // bind the selected fields, independent of adapter object prototype.
          .then((row) =>
            row
              ? {
                  binding_id: row.binding_id,
                  subject: row.subject,
                  last_withdrawn_at: row.last_withdrawn_at,
                }
              : null,
          );
      const row = await read();
      telegramCheck(row, "telegram_account_mismatch", 403);
      await options.assertAccountEnabled(accountId);
      const again = await read(),
        after = await options.authorityState(accountId);
      telegramCheck(
        after.pending === false &&
          after.revision === before.revision &&
          typeof after.permissionRevision === "string",
        "telegram_publication_pending",
        503,
      );
      telegramCheck(
        digest(again) === digest(row),
        "telegram_authority_changed",
        403,
      );
      return {
        accountId,
        wallet: row.subject,
        authorityVersion: digest([
          accountId,
          row.binding_id,
          row.subject,
          row.last_withdrawn_at,
          after.permissionRevision,
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
      // Session failures remain authentication failures. Authority errors are
      // handled only AFTER a real existing community session was established.
      let session: Awaited<ReturnType<typeof accountSession>>;
      try {
        session = await accountSession(
          request,
          options.db,
          context,
          (options.now ?? Date.now)(),
        );
      } catch {
        throw new TelegramError("telegram_session_required", 401);
      }
      try {
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
      } catch (error) {
        if (error instanceof TelegramError && error.status === 503) throw error;
        if (
          error instanceof Error &&
          error.message === "community_authority_pending" &&
          "status" in error &&
          error.status === 503 &&
          "retryable" in error &&
          error.retryable === true
        )
          throw new TelegramError("telegram_publication_pending", 503);
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
