import { sha256 } from "../packages/telegram/security.ts";
import { telegramCheck } from "../packages/telegram/contracts.ts";
import type { TelegramJournal } from "./telegram-store.ts";
import { telegramScan } from "./telegram-store.ts";

/** Account/browser transaction and OIDC verifier state live at most the
 * five-minute transaction window. Durable grants are kept independently. */
export async function telegramLinkRetention(
  store: TelegramJournal,
  now: number,
  limit = 50,
) {
  telegramCheck(
    Number.isSafeInteger(limit) && limit > 0 && limit <= 100,
    "telegram_retention_limit_invalid",
  );
  let erased = 0;
  for (const prefix of ["pending:", "link:", "broker:"]) {
    for (const row of telegramScan<Record<string, any>>(store, prefix, limit)) {
      const expiry = row.value.request?.expiresAt ?? row.value.expiresAt;
      if (!Number.isSafeInteger(expiry) || expiry > now) continue;
      const handleHash = row.value.handle
        ? await sha256(row.value.handle)
        : null;
      const completionHash = row.value.completionCode
        ? await sha256(row.value.completionCode)
        : null;
      store.transaction(() => {
        store.delete(row.key);
        if (row.value.state) store.delete(`broker-state:${row.value.state}`);
        if (handleHash) store.delete(`broker-handle:${handleHash}`);
        if (completionHash) store.delete(`broker-completion:${completionHash}`);
        erased++;
      });
    }
  }
  return { erased };
}
