import { catalogObligation } from "../packages/community/catalog-outbox.ts";
import { catalogOperationResult } from "../packages/community/catalog-publication.ts";
import { bytes32, canonical, exact, hashJson, hashText, insist, object } from "../packages/community/common.ts";
import { protectedPostsDbClock } from "../packages/community/protected-posts-fees.ts";
import type { Reconciliation } from "../packages/community/publication.ts";
import type { ExternalOperation } from "../packages/community/publication-store.ts";
import { readCanonicalIntent, type CanonicalIntentReadPorts } from "../packages/recognition/canonical-intent.ts";
import { reservationId } from "../packages/recognition/intent.ts";
import { readProtectedCatalogPosting } from "../packages/recognition/protected-catalog.ts";
import { reservationReceipt, verifyReservation } from "../packages/recognition/reservation-receipt.ts";
import type { ProtectedCatalogOperation } from "./first-song-driver.ts";
import { readNativePostsPublicationReference } from "./native-posts-publication.ts";
import { protectedCatalogReply, readProtectedCatalogReservation, type ProtectedCatalogTransport } from "./protected-catalog-reservation.ts";

export function protectedFirstSongCatalog(
  ports: CanonicalIntentReadPorts,
  transport: ProtectedCatalogTransport,
): { operation: ProtectedCatalogOperation; ready(operation: Readonly<ExternalOperation>): Promise<number> } {
  const db = ports.db;
  const read = async (jobId: string) => {
    const snapshot = await readCanonicalIntent(ports, jobId);
    const profile = snapshot.config.policies.recognition;
    insist(profile, "recognition_profile_required", 503);
    return { ...snapshot, profile };
  };
  return {
    async ready(operation) {
      const { intent, input, profile } = await read(operation.job_id);
      const lease = input.job.lease_token;
      insist(input.job.phase === "publication" && lease && Date.now() < input.job.lease_until,
        "publication_lease_lost", 409);
      const pinned = object(input.progress.catalog_reserve);
      const { receipt, expiresAtMs } = await readProtectedCatalogReservation(transport, "ready", operation, intent, profile, lease);
      insist(pinned.intentSha256 === hashJson(intent) && pinned.reservationId === receipt.reservationId &&
        pinned.recordingId === receipt.recordingId && receipt.recordingId && receipt.recordingState === "ready" &&
        receipt.publicationSha256 === null, "protected_catalog_ready_changed", 409);
      // The selected holder allows committing only for its exact retained bind.
      // Planned quote authority always comes from a fresh unbound reservation.
      insist((receipt.state === "ready" && receipt.postingSha256 === null) ||
        (operation.status === "running" && receipt.state === "committing" && receipt.postingSha256 !== null),
      "protected_catalog_ready_changed", 409);
      return Math.min(input.job.lease_until, expiresAtMs);
    },
    async operation(operation, job) {
      const { intent, config, input, profile } = await read(operation.job_id);
      const lease = job?.lease_token;
      insist(lease && input.job.lease_token === lease && input.job.phase === operation.step &&
        Date.now() < input.job.lease_until, "publication_lease_lost", 409);
      const intentSha256 = hashJson(intent);
      const metadata = "rating" in input.metadata ? input.metadata : {};
      const liveOperation = `EXISTS(SELECT 1 FROM external_operations e JOIN publication_jobs j ON j.job_id=e.job_id
        WHERE e.operation_id=? AND e.job_id=publication_catalog_obligations.job_id AND e.request_hash=?
          AND j.phase=e.step AND j.lease_token=? AND j.lease_until>${protectedPostsDbClock})`;
      const pins = [operation.operation_id, operation.request_hash, lease];
      return {
        async reserve(mode): Promise<Reconciliation> {
          insist(operation.step === "catalog_reserve", "protected_catalog_original_changed", 409);
          const evidence = await (mode === "execute"
            ? readProtectedCatalogReservation(transport, "reserve", operation, intent, profile, lease)
            : readProtectedCatalogReservation(transport, "status", operation, intent, profile));
          const { receipt, expiresAtMs } = evidence;
          if (receipt.purpose === "reservation_absent") return { kind: "absent", proof: evidence.proof };
          if (!["ready", "committing", "committed"].includes(receipt.state) || receipt.recordingState !== "ready")
            return { kind: "unknown" };
          await db.prepare(`UPDATE publication_catalog_obligations SET state='reserved'
            WHERE job_id=? AND intent_sha256=? AND reservation_id=? AND state='pending'
              AND ?>${protectedPostsDbClock} AND ${liveOperation}`)
            .bind(intent.jobId, intentSha256, receipt.reservationId, expiresAtMs, ...pins).run();
          const obligation = await catalogObligation(db, intent.jobId);
          insist(obligation.state !== "pending" && obligation.intent_sha256 === intentSha256 &&
            Date.now() < Math.min(expiresAtMs, input.job.lease_until), "protected_catalog_reservation_unavailable", 503);
          return catalogOperationResult(intent, metadata, { ...receipt, state: "ready", publicationSha256: null });
        },
        async commit(mode): Promise<Reconciliation> {
          insist(operation.step === "catalog_confirm" &&
            operation.operation_id === hashJson({ job: intent.jobId, step: "catalog_confirm" }) &&
            operation.request_hash === hashJson(JSON.parse(operation.request_json)), "protected_catalog_original_changed", 409);
          const row = await db.withSession("first-primary").prepare(`SELECT * FROM external_operations
            WHERE job_id=? AND step='publication' AND status='confirmed'`).bind(intent.jobId).first<ExternalOperation>();
          insist(row?.result_json && row.prepared_json && row.provider_id &&
            row.request_hash === hashJson(JSON.parse(row.request_json)), "catalog_chain_receipt_pending", 409);
          const chain = object(JSON.parse(row.result_json));
          insist(chain.postId === intent.postId && chain.revision === config.configurationRevision &&
            chain.transactionHash === row.provider_id, "protected_catalog_publication_changed", 409);
          const publication = readNativePostsPublicationReference(canonical({
            schema: "pirate.native-posts-publication-reference/1", installationId: transport.installationId,
            releaseSha256: transport.releaseSha256, jobId: intent.jobId, operationId: row.operation_id, requestHash: row.request_hash,
          }));
          const commit = mode === "execute";
          const request = { version: "pirate.native-posts-catalog-request/1", publication,
            confirmation: { operationId: operation.operation_id, requestHash: operation.request_hash },
            ...(commit ? { initiatingLeaseSha256: hashText(lease) } : {}) };
          const signal = AbortSignal.timeout(20_000);
          const path = commit ? "/publication/v1/posts-catalog-commit" : "/publication/v1/posts-catalog-status";
          const result = await protectedCatalogReply(transport, path, request, signal);
          exact(result, result.state === "committing" ? ["state", "posting"] :
            ["state", "posting", "publicationSha256", "requestSha256", "receipt"]);
          const posting = readProtectedCatalogPosting(result.posting);
          insist(posting.operationId === row.operation_id && posting.requestHash === row.request_hash &&
            posting.transactionHash === row.provider_id, "protected_catalog_publication_changed", 409);
          if (result.state === "committing") {
            if (commit) return { kind: "unknown" };
            insist(Date.now() < input.job.lease_until, "publication_lease_lost", 409);
            return { kind: "absent", proof: canonical({ reference: hashJson(request), result }) };
          }
          insist(result.state === "committed", "protected_catalog_terminal_invalid", 503);
          const pinned = object(input.progress.catalog_reserve);
          const rawReceipt = reservationReceipt(object(result.receipt).payload);
          const purpose = commit && rawReceipt.purpose === "publication_promoted" ? "publication_promoted" : "accepted_intent";
          const receipt = await verifyReservation(result.receipt, profile, {
            purpose, state: "committed",
            communityId: intent.communityId, configurationRevision: intent.configurationRevision,
            intentSha256, reservationId: reservationId(intent), recordingState: "ready", recordingId: bytes32(pinned.recordingId),
            requestSha256: bytes32(result.requestSha256), publicationSha256: bytes32(result.publicationSha256),
            postingSha256: hashJson(posting),
          }, Math.floor(Date.now() / 1000));
          signal.throwIfAborted();
          const expiresAtMs = Math.min(receipt.expiresAt * 1000, input.job.lease_until);
          insist(Date.now() < expiresAtMs, "protected_catalog_evidence_expired", 403);
          const postingJson = canonical(posting);
          await db.prepare(`UPDATE publication_catalog_obligations
            SET state='complete',posting_json=?,chain_receipt_json=?,promotion_receipt_json=?
            WHERE job_id=? AND intent_sha256=? AND state IN ('reserved','posting','receipt')
              AND (chain_receipt_json IS NULL OR chain_receipt_json=?) AND (posting_json IS NULL OR posting_json=?)
              AND promotion_receipt_json IS NULL AND ?>${protectedPostsDbClock} AND ${liveOperation}
              AND EXISTS(SELECT 1 FROM external_operations p WHERE p.job_id=publication_catalog_obligations.job_id
                AND p.step='publication' AND p.status='confirmed' AND p.operation_id=? AND p.request_hash=?
                AND p.prepared_json=? AND p.provider_id=? AND p.result_json=?)`)
            .bind(postingJson, row.result_json, canonical(result.receipt), intent.jobId, intentSha256,
              row.result_json, postingJson, expiresAtMs, ...pins, row.operation_id, row.request_hash,
              row.prepared_json, row.provider_id, row.result_json).run();
          const obligation = await catalogObligation(db, intent.jobId);
          insist(obligation.state === "complete" && obligation.chain_receipt_json === row.result_json &&
            obligation.posting_json === postingJson && obligation.promotion_receipt_json &&
            Date.now() < expiresAtMs, "protected_catalog_promotion_unavailable", 503);
          return catalogOperationResult(intent, metadata, receipt);
        },
      };
    },
  };
}
