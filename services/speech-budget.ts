import { DurableObject } from "cloudflare:workers";
import { check } from "../packages/protocol/index.ts";

/** One coordination object for the shared provider allowance across communities. */
export class SpeechBudget extends DurableObject<{ SPEECH_DAILY_LIMIT: string }> {
  async claim() {
    const limit = Number(this.env.SPEECH_DAILY_LIMIT);
    check(Number.isSafeInteger(limit) && limit > 0, "speech_budget_unconfigured");
    const day = Math.floor(Date.now() / 86400000);
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS speech_days (day INTEGER PRIMARY KEY, used INTEGER NOT NULL, cap INTEGER NOT NULL)");
      const row = this.ctx.storage.sql.exec<{ used: number; cap: number }>("SELECT used, cap FROM speech_days WHERE day = ?", day).toArray()[0];
      check(!row || row.cap === limit, "speech_budget_changed");
      check((row?.used ?? 0) < limit, "speech_budget_exhausted");
      this.ctx.storage.sql.exec("INSERT INTO speech_days VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET used = used + 1", day, limit);
      return { day, used: (row?.used ?? 0) + 1, limit };
    });
  }
}
