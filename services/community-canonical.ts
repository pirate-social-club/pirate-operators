import {
  canonical,
  exact,
  insist,
  integer,
  text,
  bytes32,
} from "../packages/community/common.ts";
import type { CatalogPublicationPorts } from "../packages/community/catalog-publication.ts";
import { localCanonicalCommunity } from "../packages/recognition/canonical-community.ts";
import {
  acceptedIntent,
  type AcceptedIntent,
  type PostingBinding,
} from "../packages/recognition/intent.ts";
import { verifiedPublication } from "../packages/recognition/model.ts";
import { readCanonicalIntent } from "../packages/recognition/canonical-intent.ts";
import {
  authorizeCanonicalRequest,
  canonicalPath,
  canonicalResponse,
  canonicalRequestBody,
} from "../packages/recognition/canonical-protocol.ts";
import { reservationClient } from "../packages/recognition/reservation-client.ts";
import { catalogObligation } from "../packages/community/catalog-outbox.ts";

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
  const publicationSource = () => {
    const value = body.source;
    return value && typeof value === "object" && "schema" in value
      ? acceptedIntent(value)
      : verifiedPublication(value);
  };
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
        result = {
          intent: p,
          posting: JSON.parse(obligation.posting_json),
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
