import { DurableObject } from "cloudflare:workers";
import { check } from "../packages/protocol/index.ts";
import {
  CommunitySpeechAdmission,
  type SpeechAdmissionPolicy,
  type SpeechReservationInput,
} from "./study-speech-admission.ts";

/** Legacy count plus versioned admission, scoped by community/key generation. */
export class SpeechBudget extends DurableObject<{
  SPEECH_DAILY_LIMIT: string;
  SPEECH_ADMISSION_CONFIG?: string;
}> {
  private admissionService?: CommunitySpeechAdmission;
  private admission() {
    check(this.env.SPEECH_ADMISSION_CONFIG, "speech_admission_unconfigured");
    return (this.admissionService ??= new CommunitySpeechAdmission(
      this.ctx.storage,
      JSON.parse(this.env.SPEECH_ADMISSION_CONFIG) as SpeechAdmissionPolicy,
    ));
  }
  async reserve(input: SpeechReservationInput) {
    return this.admission().reserve(input);
  }
  async dispatch(requestId: string) {
    return this.admission().dispatch(requestId);
  }
  async reservation(requestId: string) {
    return this.admission().get(requestId);
  }
  async resolve(
    requestId: string,
    state: "succeeded" | "refused" | "unknown",
    evidenceDigest: string,
  ) {
    return this.admission().resolve(requestId, state, evidenceDigest);
  }
  async claim() {
    check(!this.env.SPEECH_ADMISSION_CONFIG, "speech_admission_required");
    const limit = Number(this.env.SPEECH_DAILY_LIMIT);
    check(
      Number.isSafeInteger(limit) && limit >= 0,
      "speech_budget_unconfigured",
    );
    const day = Math.floor(Date.now() / 86400000);
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS speech_days (day INTEGER PRIMARY KEY, used INTEGER NOT NULL, cap INTEGER NOT NULL)",
      );
      const row = this.ctx.storage.sql
        .exec<{
          used: number;
          cap: number;
        }>("SELECT used, cap FROM speech_days WHERE day = ?", day)
        .toArray()[0];
      // Zero disables the app quota for the owner-operated MVP. Usage is still
      // counted; the provider account determines paid-service availability.
      check(!row || row.cap === limit || limit === 0, "speech_budget_changed");
      check(limit === 0 || (row?.used ?? 0) < limit, "speech_budget_exhausted");
      this.ctx.storage.sql.exec(
        "INSERT INTO speech_days VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET used = used + 1, cap = excluded.cap",
        day,
        limit,
      );
      return { day, used: (row?.used ?? 0) + 1, limit };
    });
  }
}
