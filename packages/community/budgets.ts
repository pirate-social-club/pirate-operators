import { amount, insist, token } from "./common.ts";

export interface BudgetKey {
  scope: string;
  period: string;
  asset: string;
}
interface Budget extends BudgetKey {
  ceiling: string;
  reserved: string;
  spent: string;
  version: number;
}
interface Reservation extends BudgetKey {
  request_hash: string;
  amount: string;
  actual: string | null;
  status: "reserved" | "settled";
}
const key = (b: BudgetKey) => [b.scope, b.period, b.asset] as const;
const unique = (keys: BudgetKey[]) =>
  new Set(keys.map((b) => JSON.stringify(key(b)))).size === keys.length;

export async function configureBudget(
  db: D1Database,
  b: BudgetKey,
  ceiling: string,
) {
  amount(ceiling);
  for (const value of key(b))
    insist(/^[A-Za-z0-9:_./-]{1,160}$/.test(value), "invalid_budget_scope");
  await db
    .prepare(
      "INSERT INTO spending_budgets(scope,period,asset,ceiling) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(...key(b), ceiling)
    .run();
  const row = await db
    .prepare(
      "SELECT ceiling FROM spending_budgets WHERE scope=? AND period=? AND asset=?",
    )
    .bind(...key(b))
    .first<{ ceiling: string }>();
  insist(row?.ceiling === ceiling, "budget_profile_changed", 409);
}

/**
 * An extra SQL condition checked in the same transaction as a new reservation.
 * A reservation replay never re-evaluates it; settlement never uses it.
 */
export interface ReservationCondition {
  clause: string;
  binds: (string | number)[];
  code: string;
}
function guard(
  db: D1Database,
  id: string,
  rows: Budget[],
  condition?: ReservationCondition,
) {
  const clauses = rows.map(
    () =>
      "EXISTS(SELECT 1 FROM spending_budgets WHERE scope=? AND period=? AND asset=? AND version=? AND ceiling=? AND reserved=? AND spent=?)",
  );
  if (condition) clauses.push(condition.clause);
  return db
    .prepare(
      `INSERT INTO transaction_guards(guard_id,valid) VALUES(?,CASE WHEN ${clauses.join(" AND ")} THEN 1 ELSE 0 END)`,
    )
    .bind(
      id,
      ...rows.flatMap((b) => [
        ...key(b),
        b.version,
        b.ceiling,
        b.reserved,
        b.spent,
      ]),
      ...(condition?.binds ?? []),
    );
}
async function snapshot(db: D1Database, id: string, keys: BudgetKey[]) {
  insist(
    keys.length > 0 && keys.length <= 4 && unique(keys),
    "invalid_budget_set",
  );
  // D1 batch executes the SELECTs in one transaction. Both sets must come
  // from the same snapshot: separate reads can straddle a winning request.
  const results = await db.batch<Budget | Reservation>([
    ...keys.map((b) =>
      db
        .prepare(
          "SELECT * FROM spending_budgets WHERE scope=? AND period=? AND asset=?",
        )
        .bind(...key(b)),
    ),
    ...keys.map((b) =>
      db
        .prepare(
          "SELECT * FROM spending_reservations WHERE reservation_id=? AND scope=? AND period=? AND asset=?",
        )
        .bind(id, ...key(b)),
    ),
  ]);
  const rows = results.slice(0, keys.length).map((r) => r.results[0]);
  insist(rows.every(Boolean), "budget_not_configured", 503);
  return {
    rows: rows as Budget[],
    previous: results
      .slice(keys.length)
      .map((r) => r.results[0] as Reservation | undefined),
  };
}
function raced(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return (
    // The community schema writes CHECK(valid = 1); the managed schema writes
    // CHECK(valid=1). Both are the same guard failure.
    /CHECK constraint failed: valid ?= ?1/.test(message) ||
    message.includes("UNIQUE constraint failed: spending_reservations")
  );
}

/** One reservation covers all configured buckets atomically; monetary values remain exact decimal text. */
export async function reserveBudget(
  db: D1Database,
  id: string,
  requestHash: string,
  keys: BudgetKey[],
  requested: string,
  condition?: ReservationCondition,
) {
  const value = amount(requested);
  insist(
    value > 0n && keys.length > 0 && keys.length <= 4 && unique(keys),
    "invalid_reservation",
  );
  for (let attempt = 0; attempt < 8; attempt++) {
    const { rows, previous } = await snapshot(db, id, keys);
    if (previous.some(Boolean)) {
      insist(previous.every(Boolean), "incomplete_budget_reservation", 503);
      insist(
        previous.every(
          (r) => r?.request_hash === requestHash && r.amount === requested,
        ),
        "reservation_conflict",
        409,
      );
      return;
    }
    for (const row of rows)
      insist(
        amount(row.reserved) + amount(row.spent) + value <= amount(row.ceiling),
        "funding_cap_exhausted",
        409,
      );
    const g = token();
    const statements = [guard(db, g, rows, condition)];
    for (const row of rows) {
      statements.push(
        db
          .prepare(
            "INSERT INTO spending_reservations(reservation_id,scope,period,asset,request_hash,amount,status) VALUES(?,?,?,?,?,?,'reserved')",
          )
          .bind(id, ...key(row), requestHash, requested),
      );
      statements.push(
        db
          .prepare(
            "UPDATE spending_budgets SET reserved=?,version=version+1 WHERE scope=? AND period=? AND asset=?",
          )
          .bind((amount(row.reserved) + value).toString(), ...key(row)),
      );
    }
    statements.push(
      db.prepare("DELETE FROM transaction_guards WHERE guard_id=?").bind(g),
    );
    try {
      await db.batch(statements);
      return;
    } catch (error) {
      if (!raced(error)) throw error;
      if (condition) {
        const held = await db
          .prepare(
            `SELECT CASE WHEN ${condition.clause} THEN 1 ELSE 0 END AS ok`,
          )
          .bind(...condition.binds)
          .first<{ ok: number }>();
        insist(held?.ok === 1, condition.code, 409);
      }
    }
  }
  insist(false, "budget_busy_retry", 409);
}

/** Unknown external results keep their reservation; only a reconciled receipt supplies actual cost. */
export async function settleBudget(
  db: D1Database,
  id: string,
  keys: BudgetKey[],
  actual: string,
) {
  const cost = amount(actual);
  for (let attempt = 0; attempt < 8; attempt++) {
    const { rows, previous } = await snapshot(db, id, keys);
    insist(previous.every(Boolean), "reservation_missing", 409);
    const saved = previous as Reservation[];
    if (saved.every((r) => r.status === "settled")) {
      insist(
        saved.every((r) => r.actual === actual),
        "settlement_conflict",
        409,
      );
      return;
    }
    insist(
      saved.every((r) => r.status === "reserved" && amount(r.amount) >= cost),
      "invalid_settlement",
      409,
    );
    const g = token();
    const statements = [guard(db, g, rows)];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!,
        reservation = saved[i]!;
      insist(
        amount(row.reserved) >= amount(reservation.amount),
        "budget_invariant_failed",
        503,
      );
      statements.push(
        db
          .prepare(
            "UPDATE spending_budgets SET reserved=?,spent=?,version=version+1 WHERE scope=? AND period=? AND asset=?",
          )
          .bind(
            (amount(row.reserved) - amount(reservation.amount)).toString(),
            (amount(row.spent) + cost).toString(),
            ...key(row),
          ),
      );
      statements.push(
        db
          .prepare(
            "UPDATE spending_reservations SET status='settled',actual=? WHERE reservation_id=? AND scope=? AND period=? AND asset=? AND status='reserved'",
          )
          .bind(actual, id, ...key(row)),
      );
    }
    statements.push(
      db.prepare("DELETE FROM transaction_guards WHERE guard_id=?").bind(g),
    );
    try {
      await db.batch(statements);
      return;
    } catch (error) {
      if (!raced(error)) throw error;
    }
  }
  insist(false, "budget_busy_retry", 409);
}
