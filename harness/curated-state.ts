// Read-only qualification of the exact held job before an in-place source update.
import { hashJson, insist, object } from "../packages/community/common.ts";

export const curatedDatabases = {
  application: "307cd8f0-cdc3-49de-884a-aeebffe75fd7",
  managed: "9887376f-8ee6-45f9-b479-6c3f95203f7a",
} as const;
export const curatedTables = {
  application: {
    community_accounts: "account_id",
    credential_bindings: "binding_id",
    creator_bindings: "account_id",
    media_submissions: "submission_id",
    publication_jobs: "job_id",
    external_operations: "operation_id",
  },
  managed: {
    managed_admissions: "admission_id",
    moderation_provider_calls: "call_id",
    spending_budgets: "scope,period,asset",
    spending_reservations: "reservation_id,scope,period,asset",
    managed_releases: "grant_hash",
    funded_pins: "operation_id",
    funded_registrations: "operation_id",
  },
} as const;
export type CuratedSide = keyof typeof curatedTables;
export interface CuratedState {
  schema: "pirate.held-first-song-state/1";
  application: Record<string, { count: number; sha256: string }>;
  managed: Record<string, { count: number; sha256: string }>;
}
/** Existing approved cf-login token only; no new credential or write surface. */
export function readOnlyRemoteDb(
  token: string,
  accountId: string,
  databaseId: string,
): D1Database {
  insist(
    accountId === "08a4c22cf52e2ecae883e36f80a33f4a" &&
      Object.values(curatedDatabases).includes(
        databaseId as typeof curatedDatabases.application,
      ),
    "curated_database_scope_changed",
    403,
  );
  const prepare = (sql: string, params: unknown[] = []) => {
    insist(
      /^SELECT\s/i.test(sql) && !sql.includes(";"),
      "curated_inspection_read_only",
      403,
    );
    const all = async () => {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify({ sql, params }),
        },
      );
      insist(response.ok, "curated_inspection_unavailable", 503);
      const body = object(await response.json());
      insist(
        body.success === true &&
          Array.isArray(body.result) &&
          body.result.length === 1,
        "curated_inspection_unavailable",
        503,
      );
      const result = object(body.result[0]);
      insist(
        result.success === true && Array.isArray(result.results),
        "curated_inspection_unavailable",
        503,
      );
      return result;
    };
    return {
      bind: (...values: unknown[]) => prepare(sql, values),
      all,
      first: async () => {
        const result = await all();
        return (result.results as unknown[])[0] ?? null;
      },
    };
  };
  return { prepare } as unknown as D1Database;
}
export async function captureCuratedState(db: D1Database, side: CuratedSide) {
  const rows: Record<string, Record<string, unknown>[]> = {},
    summary: Record<string, { count: number; sha256: string }> = {};
  for (const [table, order] of Object.entries(curatedTables[side])) {
    rows[table] = (
      await db
        .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
        .all<Record<string, unknown>>()
    ).results;
    summary[table] = {
      count: rows[table]!.length,
      sha256: hashJson(rows[table]),
    };
  }
  return { rows, summary };
}
export async function qualifyCuratedState(
  token: string,
  accountId: string,
  expected: CuratedState,
  side: CuratedSide,
) {
  insist(
    expected.schema === "pirate.held-first-song-state/1",
    "invalid_curated_state_profile",
    409,
  );
  const captured = await captureCuratedState(
    readOnlyRemoteDb(token, accountId, curatedDatabases[side]),
    side,
  );
  insist(
    hashJson(captured.summary) === hashJson(expected[side]),
    "curated_held_state_changed",
    409,
  );
  if (side === "application")
    insist(
      captured.rows.publication_jobs?.length === 1 &&
        captured.rows.publication_jobs[0]!.phase === "held" &&
        captured.rows.external_operations?.length === 1 &&
        captured.rows.external_operations[0]!.status === "failed" &&
        captured.rows.media_submissions?.length === 1 &&
        captured.rows.media_submissions[0]!.upload_state === "sealed",
      "curated_application_not_held",
      409,
    );
  else
    insist(
      captured.rows.managed_admissions?.length === 1 &&
        captured.rows.managed_admissions[0]!.state === "held" &&
        captured.rows.moderation_provider_calls?.length === 3 &&
        captured.rows.moderation_provider_calls.every(
          (c) =>
            c.state === "validated" ||
            (c.state === "received" && typeof c.response_json === "string"),
        ) &&
        ["managed_releases", "funded_pins", "funded_registrations"].every(
          (t) => captured.rows[t]?.length === 0,
        ),
      "curated_managed_not_held",
      409,
    );
  return captured.summary;
}
