import { Effect } from "effect";
import { canonical, hashJson, insist, object } from "./common.ts";
import {
  advanceJob,
  confirmOperation,
  isPublicationStep,
  leaseJob,
  loadJob,
  parkJob,
  planOperation,
  prepareOperation,
  startOperation,
  type ExternalOperation,
  type PublicationJob,
  type PublicationStep,
} from "./publication-store.ts";

export type OperationResult =
  | { kind: "confirmed"; providerId: string; value: Record<string, unknown> }
  | {
      kind: "held" | "rejected";
      providerId: string;
      code: string;
      value: Record<string, unknown>;
    };
export type Reconciliation =
  | OperationResult
  | { kind: "unknown" }
  // Only a provider-specific proof of absence permits another execution. The
  // persisted intent, nonce and signed bytes are reused without modification.
  | { kind: "absent"; proof: string };
export interface PublicationDriver {
  request(
    job: PublicationJob,
    step: PublicationStep,
  ): Promise<Record<string, unknown>>;
  // Preparation performs reads and local signing only. No billable calls,
  // broadcasts, coin allocation or provider-side operation belongs here.
  prepare(operation: ExternalOperation): Promise<Record<string, unknown>>;
  execute(operation: ExternalOperation): Promise<OperationResult>;
  reconcile(operation: ExternalOperation): Promise<Reconciliation>;
  validate(
    operation: ExternalOperation,
    result: OperationResult,
  ): Promise<void>;
}
export interface PublicationClock {
  now(): number;
}
const systemClock: PublicationClock = { now: () => Date.now() };
type Boundary = "prepared" | "started" | "confirmed";
export interface PublicationHooks {
  // Fault injection for recovery qualification. Production does not install hooks.
  boundary?(boundary: Boundary, operation: ExternalOperation): Promise<void>;
}

async function accept(
  db: D1Database,
  job: PublicationJob,
  operation: ExternalOperation,
  driver: PublicationDriver,
  result: OperationResult,
  clock: PublicationClock,
) {
  await driver.validate(operation, result);
  if (result.kind === "confirmed") {
    object(result.value);
    await confirmOperation(
      db,
      operation,
      result.value,
      result.providerId,
      clock.now(),
    );
    return result.value;
  }
  insist(/^[a-z0-9_]{1,100}$/.test(result.code), "invalid_public_error_code");
  const saved = await db
    .prepare(
      `UPDATE external_operations SET status='failed',error_code=?,result_json=?,provider_id=?,completed_at=?
    WHERE operation_id=? AND status IN ('running','uncertain')`,
    )
    .bind(
      result.code,
      canonical(result),
      result.providerId,
      clock.now(),
      operation.operation_id,
    )
    .run();
  if (saved.meta.changes !== 1) {
    const prior = await db
      .prepare(
        "SELECT result_json FROM external_operations WHERE operation_id=? AND status='failed'",
      )
      .bind(operation.operation_id)
      .first<{ result_json: string }>();
    insist(
      prior?.result_json === canonical(result),
      "conflicting_operation_result",
      409,
    );
  }
  await parkJob(
    db,
    job,
    result.kind === "held" ? "held" : "failed",
    result.code,
    clock.now(),
  );
  return null;
}

/** One bounded step. Queue deliveries are wakeups, never new operation identities. */
export function publicationStep(
  db: D1Database,
  id: string,
  driver: PublicationDriver,
  clock = systemClock,
  hooks: PublicationHooks = {},
) {
  return Effect.tryPromise({
    try: async () => {
      const job = await leaseJob(db, id, clock.now());
      if (!job) return (await loadJob(db, id)).phase;
      insist(isPublicationStep(job.phase), "invalid_job_phase", 503);
      let operation = await planOperation(
        db,
        job,
        job.phase,
        await driver.request(job, job.phase),
        clock.now(),
      );
      if (operation.status === "failed") {
        insist(operation.result_json, "missing_operation_receipt", 503);
        const result = JSON.parse(operation.result_json) as OperationResult;
        insist(
          result.kind === "held" || result.kind === "rejected",
          "invalid_failed_receipt",
          503,
        );
        await driver.validate(operation, result);
        const phase = result.kind === "held" ? "held" : "failed";
        await parkJob(db, job, phase, result.code, clock.now());
        return phase;
      }
      if (operation.status === "confirmed") {
        insist(
          operation.result_json && operation.provider_id,
          "missing_operation_receipt",
          503,
        );
        const result = {
          kind: "confirmed" as const,
          providerId: operation.provider_id,
          value: object(JSON.parse(operation.result_json)),
        };
        await driver.validate(operation, result);
        await advanceJob(db, job, job.phase, result.value, clock.now());
        return (await loadJob(db, id)).phase;
      }
      if (operation.status === "planned") {
        operation = await prepareOperation(
          db,
          job,
          operation,
          await driver.prepare(operation),
          clock.now(),
        );
        await hooks.boundary?.("prepared", operation);
      }
      let reconciledAbsent = false;
      if (operation.status === "running" || operation.status === "uncertain") {
        let reconciliation: Reconciliation;
        try {
          reconciliation = await driver.reconcile(operation);
        } catch {
          reconciliation = { kind: "unknown" };
        }
        if (reconciliation.kind === "unknown") {
          await parkJob(
            db,
            job,
            "uncertain",
            "external_result_uncertain",
            clock.now(),
          );
          return "uncertain";
        }
        if (reconciliation.kind !== "absent") {
          const value = await accept(
            db,
            job,
            operation,
            driver,
            reconciliation,
            clock,
          );
          if (value) await advanceJob(db, job, job.phase, value, clock.now());
          return (await loadJob(db, id)).phase;
        }
        insist(
          reconciliation.proof.length > 0 &&
            reconciliation.proof.length <= 4096,
          "missing_absence_proof",
          503,
        );
        // Retain reconciliation evidence before another send. It cannot replace
        // prepared bytes or alter the operation's captured request.
        const proof = { absenceProof: reconciliation.proof };
        await db
          .prepare(
            `INSERT INTO external_operation_reconciliations(operation_id,proof_sha256,proof_json,observed_at)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM publication_jobs WHERE job_id=? AND lease_token=? AND lease_until>?) ON CONFLICT DO NOTHING`,
          )
          .bind(
            operation.operation_id,
            hashJson(proof),
            canonical(proof),
            clock.now(),
            job.job_id,
            job.lease_token,
            clock.now(),
          )
          .run();
        reconciledAbsent = true;
      }
      await startOperation(db, job, operation, clock.now(), reconciledAbsent);
      await hooks.boundary?.("started", operation);
      let result: OperationResult;
      try {
        result = await driver.execute(operation);
      } catch {
        await db
          .prepare(
            "UPDATE external_operations SET status='uncertain',error_code='external_result_uncertain' WHERE operation_id=? AND status='running'",
          )
          .bind(operation.operation_id)
          .run();
        await parkJob(
          db,
          job,
          "uncertain",
          "external_result_uncertain",
          clock.now(),
        );
        return "uncertain";
      }
      const value = await accept(db, job, operation, driver, result, clock);
      await hooks.boundary?.("confirmed", operation);
      if (value) await advanceJob(db, job, job.phase, value, clock.now());
      return (await loadJob(db, id)).phase;
    },
    catch: (error) => error,
  });
}
