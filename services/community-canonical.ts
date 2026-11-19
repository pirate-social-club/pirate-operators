import { isCompactPosting } from "../packages/recognition/compact-catalog-read.ts";
import {
  canonical,
  exact,
  insist,
  integer,
  object,
  text,
  bytes32,
} from "../packages/community/common.ts";
import type { CatalogPublicationPorts } from "../packages/community/catalog-publication.ts";
import { localCanonicalCommunity, type CanonicalSource } from "../packages/recognition/canonical-community.ts";
import {
  acceptedIntent,
  type AcceptedIntent,
  type PostingBinding,
} from "../packages/recognition/intent.ts";
import { verifiedPublication } from "../packages/recognition/model.ts";
import { canonicalCompactWitness, readCanonicalIntent } from "../packages/recognition/canonical-intent.ts";
import {
  authorizeCanonicalRequest,
  canonicalPath,
  canonicalResponse,
  canonicalRequestBody,
  readCanonicalBytes,
  verifyCanonicalResponse,
  type CanonicalWireRequest,
} from "../packages/recognition/canonical-protocol.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { reservationClient } from "../packages/recognition/reservation-client.ts";
import { catalogObligation } from "../packages/community/catalog-outbox.ts";

export type ProtectedCanonicalSelectionResponder =
  (wire: CanonicalWireRequest, signal: AbortSignal) => Promise<Response>;

export interface ProtectedCanonicalApplication {
  respond: ProtectedCanonicalSelectionResponder;
  currentConfiguration(): Promise<CommunityConfig>;
  authorize(source: CanonicalSource, operationId: string, expiresAtMs: number, signal: AbortSignal): Promise<void>;
}

function canonicalSource(value: unknown): CanonicalSource {
  return value && typeof value === "object" && "schema" in value ? acceptedIntent(value) : verifiedPublication(value);
}

async function protectedCanonicalResponse(
  signal: AbortSignal,
  config: CommunityConfig,
  wire: CanonicalWireRequest,
  respond: ProtectedCanonicalSelectionResponder,
  currentConfiguration?: ProtectedCanonicalApplication["currentConfiguration"],
) {
  const response = await respond(wire, signal);
  const receipt = response.headers.get("x-pirate-canonical-receipt");
  const mime = wire.payload.action === "audio" ? "application/octet-stream" : "application/json";
  insist(response.status === 200 && response.headers.get("content-type") === mime && receipt,
    "protected_catalog_selection_unavailable", 503);
  const maximum = wire.payload.action === "audio" ? 25 * 1024 * 1024 :
    wire.payload.action === "protected_selection" ? 16 * 1024 : 512 * 1024;
  const bytes = await readCanonicalBytes(response, maximum, signal);
  await verifyCanonicalResponse(JSON.parse(receipt), wire, config, bytes);
  if (currentConfiguration) insist(canonical(await currentConfiguration()) === canonical(config), "canonical_authority_changed", 403);
  signal.throwIfAborted();
  insist(Date.now() < wire.payload.expiresAt * 1000, "canonical_response_scope_changed", 403);
  return new Response(bytes, { headers: {
    "content-type": mime, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "x-pirate-canonical-receipt": receipt,
  } });
}

export async function protectedCanonicalFetch(request: Request, config: CommunityConfig, app: ProtectedCanonicalApplication) {
  const url = new URL(request.url);
  insist(url.origin === config.app.origin && url.pathname === canonicalPath && !url.search && request.method === "POST",
    "not_found", 404);
  const wire = await authorizeCanonicalRequest(await canonicalRequestBody(request), config);
  const { body, payload: { action, signer, expiresAt } } = wire;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  switch (action) {
    case "read":
      exact(body, ["jobId"]);
      text(body.jobId, 128);
      break;
    case "source":
    case "audio":
      insist(action === "audio" || signer === config.policies.recognition?.signer, "canonical_caller_forbidden", 403);
      exact(body, ["source"]);
      canonicalSource(body.source);
      break;
    case "authorize": {
      insist(signer === config.policies.recognition?.signer, "canonical_caller_forbidden", 403);
      exact(body, ["source", "operationId"]);
      signal.throwIfAborted();
      insist(Date.now() < expiresAt * 1000, "canonical_request_scope_changed", 403);
      await app.authorize(canonicalSource(body.source), bytes32(body.operationId), expiresAt * 1000, signal);
      break;
    }
    case "ready":
      exact(body, ["intent"]);
      acceptedIntent(body.intent);
      break;
    case "protected_selection":
      break;
    default:
      insist(false, "protected_catalog_action_unavailable", 503);
  }
  signal.throwIfAborted();
  insist(Date.now() < expiresAt * 1000, "canonical_request_scope_changed", 403);
  return protectedCanonicalResponse(signal, config, wire, app.respond, app.currentConfiguration);
}

/** This action is served by retained read custody without opening the legacy signer. */
export async function protectedCanonicalSelectionFetch(
  request: Request,
  config: CommunityConfig,
  respond?: ProtectedCanonicalSelectionResponder,
) {
  const url = new URL(request.url);
  if (url.origin !== config.app.origin || url.pathname !== canonicalPath || url.search || request.method !== "POST")
    return undefined;
  const body = await canonicalRequestBody(request.clone());
  if (object(body.payload).action !== "protected_selection") return undefined;
  const wire = await authorizeCanonicalRequest(body, config);
  insist(respond, "protected_catalog_selection_unavailable", 503);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  return protectedCanonicalResponse(signal, config, wire, respond);
}

/** Reverse service protocol. Only the current pinned managed signers may call
 * it. Browser cookies and owner signatures are not service authority. */
export async function communityCanonicalFetch(
  request: Request,
  ports: CatalogPublicationPorts,
) {
  const config = await ports.currentConfiguration(),
    url = new URL(request.url);
  insist(
    url.origin === config.app.origin &&
      url.pathname === canonicalPath &&
      !url.search &&
      request.method === "POST",
    "not_found",
    404,
  );
  const wire = await authorizeCanonicalRequest(
      await canonicalRequestBody(request),
      config,
    ),
    body = wire.body;
  const source = localCanonicalCommunity(ports);
  const readyEvidence = async (p: AcceptedIntent) => {
    await source.source(p);
    const original = await readCanonicalIntent(ports, p.jobId),
      lease = original.input.job.lease_token,
      phase = original.input.job.phase;
    insist(
      lease && original.input.job.lease_until > Date.now(),
      "publication_lease_lost",
      409,
    );
    const current = async () => {
      const live = await readCanonicalIntent(ports, p.jobId);
      insist(
        canonical(live.intent) === canonical(p),
        "recognition_intent_changed",
        409,
      );
    };
    const fence = async () => {
      const row = await ports.db
        .withSession("first-primary")
        .prepare(
          `SELECT job_id FROM publication_jobs
        WHERE job_id=? AND input_hash=? AND phase=? AND lease_token=? AND lease_until>?`,
        )
        .bind(p.jobId, p.inputHash, phase, lease, Date.now())
        .first();
      insist(row, "publication_lease_lost", 409);
    };
    insist(config.policies.recognition, "recognition_profile_required", 503);
    const result = await reservationClient({
      profile: config.policies.recognition,
      publisher: ports.publisher,
      transport: ports.transport,
      current,
      beforeSend: fence,
    }).readyEvidence(p, wire.payload.nonce);
    await source.source(p);
    return { request: result.request, receipt: result.receipt };
  };
  const intent = () => acceptedIntent(body.intent);
  const publicationSource = () => canonicalSource(body.source);
  let result: unknown;
  switch (wire.payload.action) {
    case "read":
      exact(body, ["jobId"]);
      result = await source.read(text(body.jobId, 128));
      break;
    case "source":
      exact(body, ["source"]);
      result = await source.read(
        (await source.source(publicationSource())).jobId,
      );
      break;
    case "posting":
      exact(body, ["intent", "posting"]);
      result = await source.posting(intent(), body.posting as PostingBinding);
      break;
    case "publication":
      exact(body, ["intent", "posting"]);
      if(isCompactPosting(body.posting)) {
        result=(await canonicalCompactWitness(ports,intent(),body.posting)).witness;
        break;
      }
      result = {
        intent: intent(),
        posting: body.posting,
        ownerAuthorization: await ports.ownerAuthorization(),
        publication: await source.publication(
          intent(),
          body.posting as PostingBinding,
        ),
      };
      break;
    case "find_publication":
      exact(body, ["postId", "revision"]);
      const publication = await source.findPublication(
        bytes32(body.postId),
        integer(body.revision, 1, 2147483647),
      );
      if (publication) {
        const p = await source.source(publication),
          obligation = await catalogObligation(ports.db, p.jobId);
        insist(
          obligation.posting_json,
          "recognition_local_posting_journal_missing",
          409,
        );
        const posting:unknown=JSON.parse(obligation.posting_json);
        if(isCompactPosting(posting)) {
          result=(await canonicalCompactWitness(ports,p,posting)).witness;
          break;
        }
        result = {
          intent: p,
          posting,
          publication,
          ownerAuthorization: await ports.ownerAuthorization(),
        };
      } else result = null;
      break;
    case "audio":
      exact(body, ["source"]);
      result = await source.audio(publicationSource(), request.signal);
      break;
    case "authorize":
      exact(body, ["source", "operationId"]);
      await source.authorize(publicationSource(), bytes32(body.operationId));
      result = { authorized: true };
      break;
    case "ready":
      exact(body, ["intent"]);
      result = await readyEvidence(intent());
      break;
    case "protected_selection":
      insist(false, "protected_catalog_selection_unavailable", 503);
  }
  insist(
    canonical(await ports.currentConfiguration()) === canonical(config),
    "canonical_authority_changed",
    403,
  );
  insist(
    wire.payload.expiresAt > Math.floor(Date.now() / 1000),
    "canonical_request_scope_changed",
    403,
  );
  request.signal.throwIfAborted();
  return canonicalResponse(wire, config, ports.publisher, result);
}
