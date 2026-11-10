import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  CommunitySpeechAdmission,
  type SpeechAdmissionPolicy,
  type SpeechReservationInput,
} from "../services/study-speech-admission.ts";

// Runs the production SQL/transactions against SQLite. The separate Worker
// fixture covers RPC; this adapter does not claim to emulate Workerd gates.
function fixture(policy: Partial<SpeechAdmissionPolicy> = {}) {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec(sql: string, ...bindings: (number | string)[]) {
        const statement = db.prepare(sql);
        if (!statement.columns().length) {
          statement.run(...bindings);
          return { toArray: () => [] };
        }
        const rows = statement.all(...bindings);
        return {
          toArray: () => rows,
          one() {
            assert.equal(rows.length, 1);
            return rows[0];
          },
        };
      },
    },
    transactionSync<T>(fn: () => T) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let clock = 1794000000000;
  const config = {
    communityId: "0x" + "a".repeat(64),
    keyGeneration: "managed-generation-1",
    dailyUnits: 10,
    websiteStudyReservedUnits: 4,
    telegramTrialUnits: 2,
    ...policy,
  };
  const make = () =>
    new CommunitySpeechAdmission(
      storage as unknown as ConstructorParameters<
        typeof CommunitySpeechAdmission
      >[0],
      config,
      () => clock,
    );
  const input = (
    id: string,
    channel: SpeechReservationInput["channel"] = "telegram-linked",
    units = 1,
  ): SpeechReservationInput => ({
    communityId: config.communityId,
    keyGeneration: config.keyGeneration,
    requestId: id,
    channel,
    payloadDigest: "0x" + "b".repeat(64),
    units,
  });
  return {
    admission: make(),
    make,
    input,
    close: () => db.close(),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("concurrent Telegram reservations cannot consume website Study reserve", async () => {
  const f = fixture();
  try {
    const requests = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        Promise.resolve().then(() =>
          f.admission.reserve(f.input(`telegram-${i}`)),
        ),
      ),
    );
    assert.equal(requests.filter((r) => r.status === "fulfilled").length, 6);
    assert.equal(
      f.admission.reserve(f.input("web", "website-study", 4)).units,
      4,
    );
    assert.throws(
      () => f.admission.reserve(f.input("web-too-much", "website-study")),
      /budget_exhausted/,
    );
  } finally {
    f.close();
  }
});

test("trial cap, scope, request binding and zero limits fail closed", () => {
  const f = fixture();
  try {
    f.admission.reserve(f.input("trial", "telegram-trial", 2));
    assert.throws(
      () => f.admission.reserve(f.input("trial-extra", "telegram-trial")),
      /trial_budget_exhausted/,
    );
    assert.throws(
      () =>
        f.admission.reserve({ ...f.input("trial"), channel: "website-study" }),
      /request_changed/,
    );
    assert.throws(
      () =>
        f.admission.reserve({
          ...f.input("foreign"),
          communityId: "0x" + "c".repeat(64),
        }),
      /wrong_scope/,
    );
    assert.throws(() => fixture({ dailyUnits: 0 }), /policy_invalid/);
  } finally {
    f.close();
  }
});

test("dispatch is exactly once; unknown outcomes stay charged across restart until authoritative reconciliation", () => {
  const f = fixture();
  try {
    const input = f.input("dispatch", "telegram-linked", 6);
    assert.deepEqual(f.admission.reserve(input), f.admission.reserve(input));
    assert.equal(f.admission.dispatch(input.requestId).dispatch, true);
    assert.equal(f.admission.dispatch(input.requestId).dispatch, false);
    const evidence = "0x" + "e".repeat(64);
    f.admission.resolve(input.requestId, "unknown", evidence);
    f.advance(120000);
    const restored = f.make();
    assert.equal(restored.get(input.requestId)?.state, "unknown");
    assert.throws(
      () => restored.reserve(f.input("blocked")),
      /capacity_reserved/,
    );
    restored.resolve(input.requestId, "refused", evidence);
    assert.equal(
      restored.reserve(f.input("replacement", "telegram-linked", 6)).state,
      "reserved",
    );
    assert.throws(
      () => restored.resolve(input.requestId, "succeeded", evidence),
      /resolution_conflict/,
    );
  } finally {
    f.close();
  }
});

test("only undispatched reservations expire and day rollover never redispatches old work", () => {
  const f = fixture();
  try {
    f.admission.reserve(f.input("expired", "telegram-linked", 6));
    f.advance(60000);
    assert.equal(f.admission.dispatch("expired").dispatch, false);
    f.admission.reserve(f.input("accepted", "telegram-linked", 6));
    f.admission.dispatch("accepted");
    f.advance(86400000);
    assert.equal(f.admission.dispatch("accepted").dispatch, false);
    assert.equal(
      f.admission.reserve(f.input("next-day", "telegram-linked", 6)).state,
      "reserved",
    );
  } finally {
    f.close();
  }
});
