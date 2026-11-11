import { authorityReady } from "./authority-ledger.ts";

/** Accepted operator identities, never a new application action or transaction.
 * Submitted revoke nonce and observed consumed nextNonce have distinct meaning. */
export interface AcceptedWithdrawal {
  kind: "submitted" | "observed";
  nonce: string | null;
  subject: string;
  cutoffMs: number;
}

/** The website schema remains independent. Once the authority schema exists,
 * identity journaling is REQUIRED and atomic with the settings acceptance.
 * A partial migration cannot silently fall back to timestamp-only fencing. */
export async function commitWithdrawalSettings(
  db: D1Database,
  accountId: string,
  settings: D1PreparedStatement,
  identity: AcceptedWithdrawal,
) {
  const selected = await db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='learning_authority_heads'",
    )
    .first();
  if (!selected) return settings.run();
  authorityReady(
    await db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='learning_authority_withdrawals'",
      )
      .first(),
  );
  authorityReady(
    typeof identity.nonce === "string" &&
      /^(0|[1-9][0-9]{0,19})$/.test(identity.nonce) &&
      BigInt(identity.nonce) < 1n << 64n &&
      (identity.kind !== "observed" || BigInt(identity.nonce) > 0n) &&
      /^0x[0-9a-f]{40}$/.test(identity.subject) &&
      Number.isSafeInteger(identity.cutoffMs) &&
      identity.cutoffMs >= 0,
  );
  const results = await db.batch([
    settings,
    db
      .prepare(
        `INSERT INTO learning_authority_withdrawals(account_id,kind,nonce,subject,cutoff_ms)
      SELECT ?1,?2,?3,?4,?5 WHERE changes()>0
      ON CONFLICT(account_id,kind,nonce) DO NOTHING`,
      )
      .bind(
        accountId,
        identity.kind,
        identity.nonce,
        identity.subject,
        identity.cutoffMs,
      ),
  ]);
  return results[0];
}
