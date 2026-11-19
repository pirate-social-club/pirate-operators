import type { Hex } from "viem";
import { bytes32, canonical, hashText, insist, object } from "../packages/community/common.ts";
import type { OperationResult, PublicationDriver, Reconciliation } from "../packages/community/publication.ts";
import type { ExternalOperation } from "../packages/community/publication-store.ts";
import {
  preparedProtectedPostsFee, prepareProtectedPostsFee, reserveProtectedPostsFee, settleProtectedPostsFee,
} from "../packages/community/protected-posts-fees.ts";
import type { OwnerBudgetGrant } from "../packages/release/owner-grant.ts";
import {
  nativePostsDispatchPath,
  nativePostsObservationPath,
  nativePostsQuotePath,
  readNativePostsDispatchStatus,
  readNativePostsPublicationReference,
  readNativePostsPublicationStatus,
  readNativePostsQuote,
  type NativePostsPublicationReference,
  type NativePostsPublicationStatus,
} from "./native-posts-publication.ts";
import { publicationResponseBytes } from "./publication-app-documents.ts";

type JobPath = typeof nativePostsQuotePath | typeof nativePostsDispatchPath | typeof nativePostsObservationPath;

/** Selected installed transport authenticates the owner and current scope in both directions. */
export interface ProtectedPostsJobTransport {
  installationId: Hex;
  releaseSha256: Hex;
  exchange(path: JobPath, body: string, signal: AbortSignal): Promise<Response>;
}

function terminalResult(operation: ExternalOperation, status: NativePostsPublicationStatus): OperationResult | undefined {
  if (status.state !== "confirmed" && status.state !== "reverted") return;
  const { transactionHash, blockHash, blockNumber, actualFeeWei } = status;
  const receipt = { transactionHash, blockHash, blockNumber, actualFeeWei };
  if (status.state === "reverted")
    return { kind: "rejected", providerId: transactionHash, code: "publication_reverted", value: receipt };
  const publication = object(object(JSON.parse(operation.request_json)).publication);
  insist(status.postId === bytes32(publication.postId), "protected_posts_receipt_changed", 503);
  return {
    kind: "confirmed", providerId: transactionHash,
    value: { ...receipt, postId: status.postId, revision: status.revision },
  };
}

export function protectedPostsJob(
  ports: { db: D1Database; ownerGrant: OwnerBudgetGrant; maximumTotalFee: string },
  transport: ProtectedPostsJobTransport,
): Pick<PublicationDriver, "prepare" | "execute" | "reconcile" | "validate"> {
  const { installationId, releaseSha256 } = transport;
  const reference = (operation: ExternalOperation) =>
    readNativePostsPublicationReference(canonical({
      schema: "pirate.native-posts-publication-reference/1",
      installationId, releaseSha256, jobId: operation.job_id,
      operationId: operation.operation_id, requestHash: operation.request_hash,
    }));
  const exchange = async (path: JobPath, request: unknown) => {
    const signal = AbortSignal.timeout(60_000);
    const response = await transport.exchange(path, canonical(request), signal);
    insist(response.status === 200 && response.headers.get("content-type") === "application/json",
      "protected_posts_owner_unavailable", 503);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(await publicationResponseBytes(response, 16_384));
    signal.throwIfAborted();
    return raw;
  };
  const observe = async (ref: Readonly<NativePostsPublicationReference>) =>
    readNativePostsPublicationStatus(await exchange(nativePostsObservationPath, ref), ref);

  return {
    async prepare(operation, job) {
      insist(job?.lease_token, "protected_posts_owner_lease_required", 403);
      const ref = reference(operation);
      const quote = readNativePostsQuote(await exchange(nativePostsQuotePath, ref), ref);
      return prepareProtectedPostsFee(ports, operation, job, quote);
    },
    async execute(operation, job) {
      insist(job?.lease_token, "protected_posts_owner_lease_required", 403);
      const ref = reference(operation);
      const observed = await observe(ref);
      const retained = terminalResult(operation, observed);
      if (retained) return retained;
      insist(observed.state === "no_attempt", "protected_posts_publication_pending", 503);
      const quote = preparedProtectedPostsFee(ports, operation);
      await reserveProtectedPostsFee(ports, operation, job);
      insist(Date.now() < Math.min(quote.expiresAtMs, job.lease_until), "protected_posts_fee_quote_expired", 409);
      const request = {
        reference: ref, quoteSha256: quote.quoteSha256, initiatingLeaseSha256: quote.initiatingLeaseSha256,
      };
      const status = readNativePostsDispatchStatus(await exchange(nativePostsDispatchPath, request), request);
      const result = terminalResult(operation, status);
      insist(result, "protected_posts_publication_pending", 503);
      return result;
    },
    async reconcile(operation, job): Promise<Reconciliation> {
      const quote = preparedProtectedPostsFee(ports, operation);
      const ref = reference(operation);
      const status = await observe(ref);
      const retained = terminalResult(operation, status);
      if (retained) return retained;
      if (status.state === "no_attempt" && job?.lease_token && job.job_id === operation.job_id &&
          hashText(job.lease_token) === quote.initiatingLeaseSha256 &&
          Date.now() < Math.min(quote.expiresAtMs, job.lease_until))
        return { kind: "absent", proof: canonical({ reference: ref, ...status }) };
      return { kind: "unknown" };
    },
    async validate(operation, result) {
      const status = await observe(reference(operation));
      insist(status.state === "confirmed" || status.state === "reverted", "protected_posts_receipt_unavailable", 503);
      insist(canonical(terminalResult(operation, status)) === canonical(result), "protected_posts_receipt_changed", 503);
      await settleProtectedPostsFee(ports, operation, status.actualFeeWei);
    },
  };
}
