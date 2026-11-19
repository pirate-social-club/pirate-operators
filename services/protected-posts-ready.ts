import type { Hex } from "viem";
import { bytes32, canonical, exact, hashJson, hashText, insist, object } from "../packages/community/common.ts";
import { ipfsUri } from "../packages/community/manifest-core.ts";
import { catalogOwner } from "../packages/community/owner-policy.ts";
import { publicationData } from "../packages/community/post-chain.ts";
import { preparedProtectedPostsFee, protectedPostsDbClock } from "../packages/community/protected-posts-fees.ts";
import type { ExternalOperation } from "../packages/community/publication-store.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import { ownerBudgetKey, ownerLimitsDigest, type OwnerBudgetGrant } from "../packages/release/owner-grant.ts";
import { ownerPublicationRequestBinding } from "./first-song-driver.ts";
import type {
  NativePostsDispatchProof, NativePostsDispatchRequest, NativePostsPublicationReference, NativePostsQuoteProof,
} from "./native-posts-publication.ts";

interface PrimaryReadyRow {
  requestJson: string;
  preparedJson: string | null;
  inputHash: string;
  leaseToken: string;
  leaseUntil: number;
  jobRevision: number;
  jobAuthorityJson: string;
  jobProgressJson: string;
  sealedSubmission: string;
  sealedStems: string;
  catalogAuthority: string | null;
}

interface ReadyScope {
  db: D1Database;
  applicationOriginalSha256: Hex;
  releaseSha256: Hex;
  configuration: Web2CommunityConfig;
  managedOrigin: string;
  ownerGrant: OwnerBudgetGrant;
  maximumTotalFee: string;
  expiresAtMs: number;
}

type RevalidatePosts = (operation: Readonly<ExternalOperation>) =>
  Promise<{ ownerExpiresAtMs: number; catalogExpiresAtMs?: number }>;

async function readProtectedPostsPrimary(
  scope: Readonly<ReadyScope>,
  reference: Readonly<NativePostsPublicationReference>,
  revalidate: RevalidatePosts,
  dispatch?: Readonly<NativePostsDispatchRequest>,
) {
  const { db, managedOrigin, maximumTotalFee, expiresAtMs: hostExpiresAtMs } = scope;
  const applicationOriginalSha256 = bytes32(scope.applicationOriginalSha256);
  const config = structuredClone(scope.configuration);
  const grant = structuredClone(scope.ownerGrant);
  const { jobId, operationId, requestHash } = reference;
  insist(
    reference.installationId === config.installationId && reference.releaseSha256 === scope.releaseSha256 &&
      config.chainId === 6343 && config.configurationRevision === 1 && config.communityId === grant.communityId &&
      grant.communityOrigin === config.app.origin && grant.destination.chainId === config.chainId &&
      grant.destination.postsContract === config.postsContract && grant.destination.publisher === config.publisher &&
      canonical(grant.policy) === canonical(config.policies.admission),
    "protected_posts_scope_changed",
    403,
  );
  insist(Number.isSafeInteger(hostExpiresAtMs) && Date.now() < hostExpiresAtMs, "protected_posts_proof_expired", 403);
  const needsCatalog = catalogOwner(config.policies.admission);
  const catalogProjection = needsCatalog ?
    "json_array(c.intent_json,c.intent_sha256,c.reservation_id,c.state,c.posting_json,a.account_id,a.author_id,b.binding_id,b.subject,b.created_at)" :
    "NULL";
  const catalogJoins = needsCatalog ? `
      JOIN publication_catalog_obligations c ON c.job_id=j.job_id AND c.state IN ('reserved','posting')
        AND json_extract(c.intent_json,'$.inputHash')=j.input_hash AND json_extract(c.intent_json,'$.jobId')=j.job_id
      JOIN community_accounts a ON a.account_id=s.account_id AND a.author_id=s.author_id
      JOIN credential_bindings b ON b.account_id=a.account_id AND b.namespace='moss' AND b.network=6343
        AND b.subject=s.captured_wallet` : "";
  const key = ownerBudgetKey(grant, "post_fee_wei");
  const status = dispatch ? "running" : "planned";
  const feeJoins = dispatch ? `
      JOIN spending_reservations r ON r.reservation_id=o.operation_id||':fee'
      JOIN owner_budget_windows w ON w.scope=r.scope` : "";
  const feeFence = dispatch ? `
        AND o.prepared_json IS NOT NULL
        AND json_extract(o.prepared_json,'$.payload.quoteSha256')=?
        AND json_extract(o.prepared_json,'$.payload.initiatingLeaseSha256')=?
        AND json_extract(o.prepared_json,'$.payload.quoteExpiresAtMs')>${protectedPostsDbClock}
        AND r.scope=? AND r.period=? AND r.asset=? AND r.request_hash=o.request_hash
        AND r.amount=json_extract(o.prepared_json,'$.payload.maximumFeeWei') AND r.status='reserved'
        AND w.valid_from=? AND w.expires_at=? AND w.limits_sha256=?` : `
        AND o.prepared_json IS NULL
        AND NOT EXISTS(SELECT 1 FROM spending_reservations WHERE reservation_id=o.operation_id||':fee')`;
  const feePins = dispatch ? [
    dispatch.quoteSha256, dispatch.initiatingLeaseSha256, key.scope, key.period, key.asset,
    grant.validFrom, grant.expiresAt, ownerLimitsDigest(grant),
  ] : [];
  const read = () => db.withSession("first-primary").prepare(
    `SELECT o.request_json AS requestJson, o.prepared_json AS preparedJson, j.input_hash AS inputHash,
        j.lease_token AS leaseToken, j.lease_until AS leaseUntil, j.revision AS jobRevision,
        j.authority_json AS jobAuthorityJson, j.progress_json AS jobProgressJson,
        json_array(s.submission_id,s.account_id,s.author_id,s.post_id,s.request_hash,s.metadata_json,
          s.captured_wallet,s.creator_json,s.audio_sha256,s.audio_bytes,s.object_key,s.object_etag,s.sealed_at) AS sealedSubmission,
        (SELECT json_group_array(json_array(slot,sha256,byte_length,object_key,object_etag,duration_ms,sealed_at))
          FROM (SELECT slot,sha256,byte_length,object_key,object_etag,duration_ms,sealed_at FROM media_stems
            WHERE submission_id=s.submission_id ORDER BY slot)) AS sealedStems,
        ${catalogProjection} AS catalogAuthority
      FROM external_operations o JOIN publication_jobs j ON j.job_id=o.job_id
      JOIN media_submissions s ON s.submission_id=j.submission_id AND s.upload_state='sealed'
      ${catalogJoins}
      ${feeJoins}
      WHERE o.operation_id=? AND o.job_id=? AND o.request_hash=? AND o.step='publication'
        AND o.status=? AND o.result_json IS NULL AND o.provider_id IS NULL
        ${feeFence}
        AND j.phase='publication' AND j.lease_token IS NOT NULL AND j.lease_until>${protectedPostsDbClock}
        AND ?<=${protectedPostsDbClock} AND ?>${protectedPostsDbClock}
        AND (SELECT count(*) FROM media_stems WHERE submission_id=s.submission_id
          AND slot IN ('instrumental','vocals') AND state='sealed' AND object_key IS NOT NULL
          AND object_etag IS NOT NULL AND duration_ms>0)=2
        AND EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)
        AND EXISTS(SELECT 1 FROM native_application_original WHERE singleton=1 AND original_digest=?)`,
  ).bind(operationId, jobId, requestHash, status, ...feePins, grant.validFrom * 1000, grant.expiresAt * 1000,
    config.communityId, config.app.origin, applicationOriginalSha256.slice(2))
    .first<PrimaryReadyRow>();
  const current = await read();
  insist(current && Number.isSafeInteger(current.leaseUntil),
    "protected_posts_primary_original_unavailable", 503);
  const initiatingLeaseSha256 = hashText(current.leaseToken);
  insist(!dispatch || initiatingLeaseSha256 === dispatch.initiatingLeaseSha256,
    "protected_posts_initiating_lease_changed", 409);

  const operation = Object.freeze<ExternalOperation>({
    operation_id: operationId, job_id: jobId, request_hash: requestHash,
    request_json: current.requestJson, prepared_json: current.preparedJson,
    step: "publication", status, result_json: null, provider_id: null,
  });
  const quote = dispatch && preparedProtectedPostsFee({ db, maximumTotalFee, ownerGrant: grant }, operation);
  const originalRequest = object(JSON.parse(current.requestJson));
  exact(originalRequest, ["schema", "grantHash", "serviceOrigin", "step", "inputHash", "context", "publication"]);
  insist(current.requestJson === canonical(originalRequest) && hashJson(originalRequest) === requestHash &&
    originalRequest.schema === "pirate.first-song-publication-request/1" && originalRequest.step === "publication" &&
    originalRequest.grantHash === ownerPublicationRequestBinding(grant) &&
    originalRequest.serviceOrigin === managedOrigin && originalRequest.inputHash === current.inputHash,
    "protected_posts_original_changed", 409);
  const publication = object(originalRequest.publication);
  exact(publication, ["communityId", "postId", "authorId", "configurationRevision", "manifestSha256", "manifestURI"]);
  insist(publication.communityId === config.communityId && publication.configurationRevision === config.configurationRevision,
    "protected_posts_scope_changed", 403);
  const originalPublication = Object.freeze({
    communityId: config.communityId, postId: bytes32(publication.postId), authorId: bytes32(publication.authorId),
    configurationRevision: 1 as const, manifestSha256: bytes32(publication.manifestSha256),
    manifestURI: ipfsUri(publication.manifestURI),
  });
  const calldata = publicationData(originalPublication);
  const configurationSha256 = hashJson(config);
  const { ownerExpiresAtMs, catalogExpiresAtMs } = await revalidate(operation);
  insist(Number.isSafeInteger(ownerExpiresAtMs), "protected_posts_owner_authority_unavailable", 503);
  let expiresAtMs = Math.min(hostExpiresAtMs, quote?.expiresAtMs ?? hostExpiresAtMs,
    current.leaseUntil, grant.expiresAt * 1000, ownerExpiresAtMs);
  if (needsCatalog) {
    insist(typeof catalogExpiresAtMs === "number" && Number.isSafeInteger(catalogExpiresAtMs),
      "protected_posts_catalog_authority_unavailable", 503);
    expiresAtMs = Math.min(expiresAtMs, catalogExpiresAtMs);
  }
  const latest = await read();
  insist(latest && canonical({ ...latest }) === canonical({ ...current }), "protected_posts_primary_original_changed", 409);
  insist(Date.now() < expiresAtMs, "protected_posts_proof_expired", 403);
  return {
    quote, initiatingLeaseSha256, applicationOriginalSha256, configurationSha256, grantSha256: bytes32(grant.sha256),
    publication: originalPublication, calldata, expiresAtMs,
  };
}

/** The quote reader exposes read-only facts for the selected owner qualifier. */
export async function readProtectedPostsPlanned(
  scope: Readonly<ReadyScope>,
  reference: Readonly<NativePostsPublicationReference>,
  revalidate: RevalidatePosts,
): Promise<Readonly<NativePostsQuoteProof>> {
  const { initiatingLeaseSha256, applicationOriginalSha256, configurationSha256, grantSha256, publication, expiresAtMs } =
    await readProtectedPostsPrimary(scope, reference, revalidate);
  return Object.freeze({
    version: "pirate.native-posts-quote-proof/1",
    applicationOriginalSha256, configurationSha256, grantSha256, initiatingLeaseSha256, expiresAtMs, publication,
  });
}

/** Dispatch requires the same initiating lease and its reserved quote. */
export async function readProtectedPostsReady(
  scope: Readonly<ReadyScope>,
  request: Readonly<NativePostsDispatchRequest>,
  revalidate: RevalidatePosts,
): Promise<Readonly<NativePostsDispatchProof>> {
  const { quote, calldata, expiresAtMs } = await readProtectedPostsPrimary(scope, request.reference, revalidate, request);
  insist(quote, "protected_posts_primary_original_unavailable", 503);
  return Object.freeze({ ...quote, calldata, expiresAtMs });
}
