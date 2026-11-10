import { check, digest } from "../packages/protocol/index.ts";

export const SPEECH_ADMISSION_SCHEMA = "pirate.speech-admission/1" as const;
export const speechChannels = [
  "website-study",
  "website-karaoke",
  "telegram-linked",
  "telegram-trial",
  "processing",
] as const;
export type SpeechChannel = (typeof speechChannels)[number];
export interface SpeechAdmissionPolicy {
  communityId: string;
  keyGeneration: string;
  dailyUnits: number;
  websiteStudyReservedUnits: number;
  telegramTrialUnits: number;
}
export interface SpeechReservationInput {
  communityId: string;
  keyGeneration: string;
  channel: SpeechChannel;
  requestId: string;
  payloadDigest: string;
  units: number;
}
export interface SpeechReservation extends SpeechReservationInput {
  schema: typeof SPEECH_ADMISSION_SCHEMA;
  day: number;
  expiresAt: number;
  state:
    | "reserved"
    | "dispatched"
    | "succeeded"
    | "refused"
    | "unknown"
    | "cancelled";
  evidenceDigest: string | null;
}
type AdmissionStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
const charged = "('reserved','dispatched','succeeded','unknown')";
export const speechAdmissionObjectName = (
  scope: Pick<SpeechAdmissionPolicy, "communityId" | "keyGeneration">,
) => `speech-admission-v1:${scope.communityId}:${scope.keyGeneration}`;

/** Trusted binding API, never a learner-controlled HTTP endpoint. All money
 * and key-generation changes remain the community operator's responsibility. */
export class CommunitySpeechAdmission {
  private storage: AdmissionStorage;
  private policy: SpeechAdmissionPolicy;
  private now: () => number;
  constructor(
    storage: AdmissionStorage,
    policy: SpeechAdmissionPolicy,
    now = Date.now,
  ) {
    this.storage = storage;
    this.policy = policy;
    this.now = now;
    check(
      /^0x[0-9a-f]{64}$/.test(policy.communityId) &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(policy.keyGeneration),
      "speech_admission_scope_invalid",
    );
    check(
      [
        policy.dailyUnits,
        policy.websiteStudyReservedUnits,
        policy.telegramTrialUnits,
      ].every(Number.isSafeInteger) &&
        policy.dailyUnits > 0 &&
        policy.websiteStudyReservedUnits > 0 &&
        policy.websiteStudyReservedUnits <= policy.dailyUnits &&
        policy.telegramTrialUnits >= 0 &&
        policy.telegramTrialUnits <=
          policy.dailyUnits - policy.websiteStudyReservedUnits,
      "speech_admission_policy_invalid",
    );
    storage.transactionSync(() => {
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS speech_admission_scope (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL)",
      );
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS speech_reservations (request_id TEXT PRIMARY KEY, day INTEGER NOT NULL, channel TEXT NOT NULL, units INTEGER NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, value TEXT NOT NULL)",
      );
      storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS speech_reservations_day ON speech_reservations(day,state,channel)",
      );
      const old = storage.sql
        .exec<{
          policy: string;
        }>("SELECT policy FROM speech_admission_scope WHERE id=1")
        .toArray()[0];
      // A cap/key change is a new reviewed generation, never a mid-day reset.
      check(
        !old || old.policy === digest(policy),
        "speech_admission_policy_changed",
      );
      storage.sql.exec(
        "INSERT OR IGNORE INTO speech_admission_scope VALUES(1,?)",
        digest(policy),
      );
    });
  }
  private read(id: string) {
    const row = this.storage.sql
      .exec<{
        value: string;
      }>("SELECT value FROM speech_reservations WHERE request_id=?", id)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as SpeechReservation) : null;
  }
  private save(row: SpeechReservation) {
    this.storage.sql.exec(
      "INSERT INTO speech_reservations VALUES(?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET state=excluded.state,value=excluded.value",
      row.requestId,
      row.day,
      row.channel,
      row.units,
      row.state,
      row.expiresAt,
      JSON.stringify(row),
    );
    return row;
  }
  reserve(input: SpeechReservationInput): SpeechReservation {
    check(
      input.communityId === this.policy.communityId &&
        input.keyGeneration === this.policy.keyGeneration,
      "speech_admission_wrong_scope",
    );
    check(
      speechChannels.includes(input.channel) &&
        /^[a-zA-Z0-9:_-]{1,160}$/.test(input.requestId) &&
        /^0x[0-9a-f]{64}$/.test(input.payloadDigest) &&
        Number.isSafeInteger(input.units) &&
        input.units > 0 &&
        input.units <= this.policy.dailyUnits,
      "speech_admission_request_invalid",
    );
    return this.storage.transactionSync(() => {
      const old = this.read(input.requestId);
      if (old) {
        const { schema, day, expiresAt, state, evidenceDigest, ...previous } =
          old;
        check(
          digest(previous) === digest(input),
          "speech_admission_request_changed",
        );
        return old;
      }
      const now = this.now(),
        day = Math.floor(now / 86400000);
      // Only undispatched reservations may expire. Unknown provider work is
      // never refunded by timeout or clock rollover.
      for (const row of this.storage.sql
        .exec<{
          value: string;
        }>("SELECT value FROM speech_reservations WHERE state='reserved' AND expires_at<=?", now)
        .toArray())
        this.save({ ...JSON.parse(row.value), state: "cancelled" });
      const usage = this.storage.sql
        .exec<{
          total: number;
          other: number;
          trial: number;
        }>(`SELECT COALESCE(SUM(units),0) total, COALESCE(SUM(CASE WHEN channel!='website-study' THEN units ELSE 0 END),0) other, COALESCE(SUM(CASE WHEN channel='telegram-trial' THEN units ELSE 0 END),0) trial FROM speech_reservations WHERE day=? AND state IN ${charged}`, day)
        .one();
      check(
        usage.total + input.units <= this.policy.dailyUnits,
        "speech_budget_exhausted",
      );
      if (input.channel !== "website-study")
        check(
          usage.other + input.units <=
            this.policy.dailyUnits - this.policy.websiteStudyReservedUnits,
          "speech_website_capacity_reserved",
        );
      if (input.channel === "telegram-trial")
        check(
          usage.trial + input.units <= this.policy.telegramTrialUnits,
          "speech_trial_budget_exhausted",
        );
      return this.save({
        ...input,
        schema: SPEECH_ADMISSION_SCHEMA,
        day,
        expiresAt: Math.min(now + 60000, (day + 1) * 86400000),
        state: "reserved",
        evidenceDigest: null,
      });
    });
  }
  get(requestId: string) {
    return this.read(requestId);
  }
  dispatch(requestId: string) {
    return this.storage.transactionSync(() => {
      const row = this.read(requestId);
      check(row, "speech_reservation_not_found");
      if (row.state !== "reserved")
        return { dispatch: false, reservation: row };
      if (row.expiresAt <= this.now())
        return {
          dispatch: false,
          reservation: this.save({ ...row, state: "cancelled" }),
        };
      return {
        dispatch: true,
        reservation: this.save({ ...row, state: "dispatched" }),
      };
    });
  }
  resolve(
    requestId: string,
    state: "succeeded" | "refused" | "unknown",
    evidenceDigest: string,
  ) {
    check(
      /^0x[0-9a-f]{64}$/.test(evidenceDigest),
      "speech_resolution_evidence_required",
    );
    return this.storage.transactionSync(() => {
      const row = this.read(requestId);
      check(row, "speech_reservation_not_found");
      if (row.state === state) {
        check(
          row.evidenceDigest === evidenceDigest,
          "speech_resolution_changed",
        );
        return row;
      }
      check(
        row.state === "dispatched" ||
          row.state === "unknown" ||
          (row.state === "reserved" && state === "refused"),
        "speech_resolution_conflict",
      );
      return this.save({ ...row, state, evidenceDigest });
    });
  }
}
