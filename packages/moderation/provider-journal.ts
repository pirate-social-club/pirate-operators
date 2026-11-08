import {
  canonical,
  hashJson,
  insist,
  object,
  token,
} from "../community/common.ts";
import {
  reserveBudget,
  settleBudget,
  type BudgetKey,
} from "../community/budgets.ts";
import type { ProviderResponse } from "./provider-http.ts";

interface Call {
  call_id: string;
  admission_id: string;
  kind: string;
  request_hash: string;
  state: "planned" | "running" | "received" | "uncertain" | "validated";
  execution_token: string | null;
  response_json: string | null;
  result_json: string | null;
}
export interface AdmissionLease {
  admissionId: string;
  token: string;
}
export interface ProviderCall {
  /** Extra condition checked atomically with the budget reservation. */
  condition?: import("../community/budgets.ts").ReservationCondition;
  kind:
    | "acr_primary"
    | "acr_alternate"
    | "text_moderation"
    | "lyrics_classification";
  request: Record<string, unknown>;
  budgets: BudgetKey[];
  authorize(): Promise<void>;
  /**
   * Checked after the reservation and before the call is claimed for sending.
   * A refusal releases the reservation and leaves the call planned; a released
   * call is never sent.
   */
  dispatch?(): Promise<void>;
  // Receipt persistence must finish before parsing or returning the response.
  send(
    received: (response: ProviderResponse) => Promise<void>,
  ): Promise<unknown>;
  interpret(response: ProviderResponse): Record<string, unknown>;
}
export class UncertainProviderCall extends Error {
  constructor() {
    super("provider_result_uncertain");
  }
}
async function callRow(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT * FROM moderation_provider_calls WHERE call_id=?")
    .bind(id)
    .first<Call>();
  insist(row, "provider_call_missing", 503);
  return row;
}

/** Non-idempotent upstreams receive at most one send for a captured call.
 * An absence lookup or expired worker lease never grants a second send. */
export async function journaledProviderCall(
  db: D1Database,
  lease: AdmissionLease,
  call: ProviderCall,
  now = () => Date.now(),
) {
  const id = hashJson({ admissionId: lease.admissionId, kind: call.kind }),
    requestHash = hashJson({ input: call.request, budgets: call.budgets });
  await db
    .prepare(
      `INSERT INTO moderation_provider_calls(call_id,admission_id,kind,request_hash,request_json,state)
    SELECT ?,?,?,?,?,'planned' WHERE EXISTS(SELECT 1 FROM managed_admissions WHERE admission_id=? AND lease_token=? AND lease_until>?)
    ON CONFLICT(admission_id,kind) DO NOTHING`,
    )
    .bind(
      id,
      lease.admissionId,
      call.kind,
      requestHash,
      canonical({ input: call.request, budgets: call.budgets }),
      lease.admissionId,
      lease.token,
      now(),
    )
    .run();
  let row = await callRow(db, id);
  insist(row.request_hash === requestHash, "provider_call_intent_changed", 409);
  if (row.state === "validated") {
    insist(row.result_json, "provider_result_missing", 503);
    return object(JSON.parse(row.result_json));
  }
  if (row.state === "planned") {
    await call.authorize();
    await reserveBudget(db, id, requestHash, call.budgets, "1", call.condition);
    // A reservation released by an earlier dispatch refusal never sends.
    const reservation = await db
      .prepare(
        "SELECT status FROM spending_reservations WHERE reservation_id=? LIMIT 1",
      )
      .bind(id)
      .first<{ status: string }>();
    insist(reservation?.status === "reserved", "provider_call_released", 409);
    try {
      await call.dispatch?.();
    } catch (error) {
      // Nothing was sent: release the units rather than hold them in a window
      // that is ending. The call stays planned and can never be sent. Only
      // the executor holding the admission lease releases: the lease is the
      // invariant that keeps one executor per planned call, and the running
      // claim below requires the same lease. Without it, keep the reservation.
      const held = await db
        .prepare(
          "SELECT 1 AS held FROM managed_admissions WHERE admission_id=? AND lease_token=? AND lease_until>?",
        )
        .bind(lease.admissionId, lease.token, now())
        .first();
      if (held) await settleBudget(db, id, call.budgets, "0");
      throw error;
    }
    const execution = token();
    const claimed = await db
      .prepare(
        `UPDATE moderation_provider_calls SET state='running',execution_token=?,started_at=?
      WHERE call_id=? AND state='planned' AND EXISTS(SELECT 1 FROM managed_admissions WHERE admission_id=? AND lease_token=? AND lease_until>?)`,
      )
      .bind(execution, now(), id, lease.admissionId, lease.token, now())
      .run();
    insist(claimed.meta.changes === 1, "admission_lease_lost", 409);
    try {
      await call.send(async (response) => {
        const json = canonical(response);
        await db
          .prepare(
            `UPDATE moderation_provider_calls SET state='received',response_json=?,provider_id=?
          WHERE call_id=? AND execution_token=? AND state IN ('running','uncertain')`,
          )
          .bind(json, response.requestId ?? response.bodySha256, id, execution)
          .run();
        const saved = await callRow(db, id);
        insist(
          saved.response_json === json,
          "provider_receipt_persistence_unconfirmed",
          503,
        );
      });
    } catch {
      // A response retained before a parse error is still recoverable. Without
      // one, preserve the full reservation and wait for evidence, never resend.
      await db
        .prepare(
          "UPDATE moderation_provider_calls SET state='uncertain' WHERE call_id=? AND execution_token=? AND state='running'",
        )
        .bind(id, execution)
        .run();
    }
    row = await callRow(db, id);
  }
  if (
    (row.state === "running" || row.state === "uncertain") &&
    !row.response_json
  )
    throw new UncertainProviderCall();
  insist(row.response_json, "provider_receipt_missing", 503);
  const response = JSON.parse(row.response_json) as ProviderResponse;
  // Every received request consumes one unit, including refusals and 5xx.
  // The configured cap is a request quota; monetary/token quotes are separate.
  await settleBudget(db, id, call.budgets, "1");
  const result = call.interpret(response),
    json = canonical(result);
  const saved = await db
    .prepare(
      `UPDATE moderation_provider_calls SET state='validated',result_json=?,completed_at=?
    WHERE call_id=? AND request_hash=? AND state='received' AND response_json=?`,
    )
    .bind(json, now(), id, requestHash, row.response_json)
    .run();
  if (saved.meta.changes !== 1)
    insist(
      (await callRow(db, id)).result_json === json,
      "conflicting_provider_interpretation",
      409,
    );
  return result;
}
