import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  CommunitySpeechAdmission,
  speechAdmissionObjectName,
  type SpeechAdmissionPolicy,
} from "../services/study-speech-admission.ts";
import type { SpeechAdmissionEnv } from "../services/study-speech-reservation.ts";
import type { ResultStore } from "../services/learning-transactions.ts";

/** Actual admission SQL and an operator journal on local SQLite. No chain,
 * Worker build, provider network, browser or funded operation is involved. */
export function speechRepairFixture(
  overrides: Partial<SpeechAdmissionPolicy> = {},
) {
  const db = new DatabaseSync(":memory:");
  const transaction = <T>(fn: () => T) => {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const storage = {
    transactionSync: transaction,
    sql: {
      exec(sql: string, ...bindings: (string | number)[]) {
        const query = db.prepare(sql);
        const rows = query.columns().length
          ? query.all(...bindings)
          : (query.run(...bindings), []);
        return {
          toArray: () => rows,
          one: () => {
            assert.equal(rows.length, 1);
            return rows[0];
          },
        };
      },
    },
  };
  let now = 1800000000;
  const policy = {
    communityId: `0x${"a".repeat(64)}`,
    keyGeneration: "fixture-repair1",
    dailyUnits: 10,
    websiteStudyReservedUnits: 4,
    telegramTrialUnits: 2,
    ...overrides,
  };
  const admission = new CommunitySpeechAdmission(
    storage as unknown as ConstructorParameters<
      typeof CommunitySpeechAdmission
    >[0],
    policy,
    () => now * 1000,
  );
  db.exec(
    "CREATE TABLE operator_records (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  const store: ResultStore = {
    get: <T>(key: string) => {
      const row = db
        .prepare("SELECT value FROM operator_records WHERE key=?")
        .get(key);
      return row ? (JSON.parse(String(row.value)) as T) : undefined;
    },
    set: (key, value) => {
      db.prepare(
        "INSERT INTO operator_records VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(key, JSON.stringify(value));
    },
    delete: (key) => {
      db.prepare("DELETE FROM operator_records WHERE key=?").run(key);
    },
    entries: (prefix) =>
      db
        .prepare(
          "SELECT key,value FROM operator_records WHERE substr(key,1,length(?))=? ORDER BY key",
        )
        .all(prefix, prefix)
        .map((row) => ({
          key: String(row.key),
          value: JSON.parse(String(row.value)) as unknown,
        })),
    transaction,
    now: () => now,
  };
  const resolutions: {
    requestId: string;
    state: string;
    evidenceDigest: string;
  }[] = [];
  const env: SpeechAdmissionEnv = {
    SPEECH_ADMISSION_CONFIG: JSON.stringify(policy),
    SPEECH_BUDGET: {
      getByName(name: string) {
        assert.equal(name, speechAdmissionObjectName(policy));
        return {
          reserve: async (...input: Parameters<typeof admission.reserve>) =>
            admission.reserve(...input),
          dispatch: async (...input: Parameters<typeof admission.dispatch>) =>
            admission.dispatch(...input),
          resolve: async (...input: Parameters<typeof admission.resolve>) => {
            resolutions.push({
              requestId: input[0],
              state: input[1],
              evidenceDigest: input[2],
            });
            return admission.resolve(...input);
          },
        };
      },
    } as unknown as SpeechAdmissionEnv["SPEECH_BUDGET"],
  };
  return {
    db,
    store,
    policy,
    env,
    admission,
    resolutions,
    advance: (seconds: number) => {
      now += seconds;
    },
    close: () => db.close(),
  };
}
