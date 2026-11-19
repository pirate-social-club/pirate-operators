import { bytes32, canonical, exact, hashJson, hashText, insist, integer, object } from "../packages/community/common.ts";
import type { ExternalOperation } from "../packages/community/publication-store.ts";
import { reservationId, type AcceptedIntent, type RecognitionProfile } from "../packages/recognition/intent.ts";
import { reservationReceipt, verifyReservation } from "../packages/recognition/reservation-receipt.ts";
import { publicationResponseBytes } from "./publication-app-documents.ts";
import { nativePostsCatalogReservationPath } from "./native-posts-publication.ts";

type ReservationPurpose = "reserve" | "status" | "ready";
export type ProtectedCatalogTransport = {
  installationId: string;
  releaseSha256: string;
  exchange(path: string, body: string, signal: AbortSignal): Promise<Response>;
};

export async function protectedCatalogReply(
  transport: ProtectedCatalogTransport, path: string, request: unknown, signal: AbortSignal,
) {
  const response = await transport.exchange(path, canonical(request), signal);
  insist(response.status === 200 && response.headers.get("content-type") === "application/json",
    "protected_catalog_owner_unavailable", 503);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(await publicationResponseBytes(response, 16_384));
  const reply = object(JSON.parse(raw));
  exact(reply, ["reference", "result"]);
  insist(raw === canonical(reply) && reply.reference === hashJson(request), "protected_catalog_reply_changed", 503);
  signal.throwIfAborted();
  return object(reply.result);
}

export async function readProtectedCatalogReservation(
  transport: ProtectedCatalogTransport,
  purpose: ReservationPurpose,
  operation: Readonly<ExternalOperation>,
  intent: AcceptedIntent,
  profile: RecognitionProfile,
  leaseToken?: string | null,
) {
  const step = purpose === "ready" ? "publication" : "catalog_reserve";
  const jobId = operation.job_id;
  insist(jobId === intent.jobId && operation.step === step &&
    operation.operation_id === hashJson({ job: jobId, step }) &&
    operation.request_hash === hashJson(JSON.parse(operation.request_json)) &&
    (purpose === "status" ? leaseToken === undefined : Boolean(leaseToken)),
  "protected_catalog_original_changed", 409);
  const request = {
    version: "pirate.native-posts-catalog-reservation-request/1", purpose,
    reference: { installationId: bytes32(transport.installationId), releaseSha256: bytes32(transport.releaseSha256),
      jobId, operationId: operation.operation_id, requestHash: operation.request_hash, step },
    ...(leaseToken ? { initiatingLeaseSha256: hashText(leaseToken) } : {}),
  };
  const signal = AbortSignal.timeout(15_000);
  const result = await protectedCatalogReply(transport, nativePostsCatalogReservationPath, request, signal);
  exact(result, ["requestSha256", "requestExpiresAt", "receipt"]);
  const now = Math.floor(Date.now() / 1000);
  const requestSha256 = bytes32(result.requestSha256);
  const requestExpiresAt = integer(result.requestExpiresAt, now + 1, now + 120);
  const raw = reservationReceipt(object(result.receipt).payload);
  const purposePin = purpose === "status" && raw.purpose === "reservation_absent" ? "reservation_absent" : "accepted_intent";
  const receipt = await verifyReservation(result.receipt, profile, {
    purpose: purposePin, communityId: intent.communityId, configurationRevision: intent.configurationRevision,
    intentSha256: hashJson(intent), reservationId: reservationId(intent), requestSha256,
  }, now);
  const expiresAtMs = Math.min(receipt.expiresAt, requestExpiresAt) * 1000;
  signal.throwIfAborted();
  insist(Date.now() < expiresAtMs, "protected_catalog_evidence_expired", 403);
  return { receipt, expiresAtMs, proof: canonical(result) };
}
