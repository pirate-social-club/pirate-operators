import {
  accountSession,
  authenticatedWrite,
} from "../packages/community/accounts.ts";
import {
  CommunityError,
  exact,
  insist,
  integer,
  jsonBody,
  object,
  requestOrigin,
  text,
} from "../packages/community/common.ts";
import type { DancePorts } from "../packages/dance/contracts.ts";
import { danceId } from "../packages/dance/validation.ts";
import { DanceReviewService } from "./dance-review.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { decodeDanceDecision } from "../packages/dance/commands.ts";
import type { DanceSelectedCatalogue } from "./dance-production.ts";
import { requireProductionTarget } from "./dance-production.ts";
import { DanceProductionReads } from "./dance-production-reads.ts";

export interface DanceCommunityPorts {
  db: D1Database;
  dance: DancePorts;
  /** Required for production catalogue/access routes; no successful fallback. */
  catalogue?: DanceSelectedCatalogue;
}
/** Shared Worker mount is coordinator-owned. This adapter never trusts actor JSON. */
export async function danceCommunityApi(
  request: Request,
  ports: DanceCommunityPorts,
  context: { communityId: `0x${string}`; origin: string },
  headers: Headers,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/dance/")) return null;
  if (request.method !== "GET") requestOrigin(request, context.origin);
  const session =
    request.method === "GET"
      ? await accountSession(request, ports.db, context)
      : await authenticatedWrite(request, ports.db, context);
  const expected = request.headers.get("x-dance-account");
  if (expected !== null)
    insist(expected === session.account_id, "dance_account_changed", 409);
  const api = new DanceReviewService(
      new DanceStore(ports.db),
      ports.dance,
      context.communityId,
    ),
    actor = session.account_id;
  const privateHeaders = new Headers(headers);
  privateHeaders.set("cache-control", "no-store, private");
  privateHeaders.set("vary", "Cookie");
  const reply = (v: unknown) => Response.json(v, { headers: privateHeaders });
  const captureRead = /^\/api\/dance\/captures\/([a-zA-Z0-9_:-]{1,128})\/(access|guide)$/.exec(url.pathname);
  const songRead = /^\/api\/dance\/songs\/(0x[0-9a-f]{64})$/.exec(url.pathname);
  if (["/api/dance/catalogue", "/api/dance/latest", "/api/dance/reference"].includes(url.pathname) || captureRead || songRead) {
    insist(request.method === "GET", "method_not_allowed", 405);
    insist(ports.catalogue, "dance_production_catalogue_unavailable", 503);
    const reads = new DanceProductionReads(ports.db, ports.dance, ports.catalogue, context.communityId);
    if (songRead) return reply(await reads.songKeyForPost(actor, songRead[1]));
    if (captureRead) return reply(captureRead[2] === "access"
      ? { version: "pirate.dance-capture-access/1", capture: await reads.captureAccess(actor, captureRead[1]) }
      : await reads.guide(actor, captureRead[1], context.origin));
    if (url.pathname === "/api/dance/catalogue") {
      const cursor = url.searchParams.get("cursor");
      insist(cursor === null || cursor.length <= 2048, "dance_invalid_cursor");
      return reply(await reads.cataloguePage(actor, text(url.searchParams.get("songKey"), 128), cursor));
    }
    const raw = url.searchParams.get("target");
    insist(raw && raw.length <= 2048, "dance_invalid_target");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new CommunityError("dance_invalid_target"); }
    const target = requireProductionTarget(value, context.communityId);
    return reply(url.pathname === "/api/dance/latest"
      ? await reads.latest(actor, target) : await reads.reference(actor, target));
  }
  if (url.pathname === "/api/dance/queue") {
    insist(request.method === "GET", "method_not_allowed", 405);
    return reply(await api.queue(actor, url.searchParams.get("cursor")));
  }
  const match =
    /^\/api\/dance\/reviews\/([a-zA-Z0-9_:-]{1,128})(?:\/(verdict|withdraw|expire))?$/.exec(
      url.pathname,
    );
  if (match && !match[2]) {
    insist(request.method === "GET", "method_not_allowed", 405);
    return reply(await api.get(actor, match[1]));
  }
  insist(request.method === "POST", "method_not_allowed", 405);
  const body = object(await jsonBody(request));
  if (url.pathname === "/api/dance/captures") {
    exact(body, ["commandId", "songKey", "offerId", "referenceId", "consent"]);
    const consent = object(body.consent);
    exact(consent, ["accepted", "version", "termsHash", "publicityPolicyHash"]);
    insist(consent.accepted === true, "dance_consent_required", 403);
    return reply(
      await api.capture(
        actor,
        danceId(body.commandId),
        {
          songKey: text(body.songKey, 128),
          offerId: body.offerId === null ? null : danceId(body.offerId),
          referenceId:
            body.referenceId === null ? null : danceId(body.referenceId),
        },
        {
          accepted: true,
          version: text(consent.version, 128),
          termsHash: text(consent.termsHash, 128),
          publicityPolicyHash: text(consent.publicityPolicyHash, 128),
        },
      ),
    );
  }
  if (url.pathname === "/api/dance/reviews") {
    exact(body, ["commandId", "captureId", "mediaId", "recordingSha256"]);
    return reply(
      await api.submit(
        actor,
        danceId(body.commandId),
        danceId(body.captureId),
        danceId(body.mediaId),
        text(body.recordingSha256, 128),
      ),
    );
  }
  if (url.pathname === "/api/dance/delegations") {
    exact(body, [
      "commandId",
      "delegationId",
      "accountId",
      "operation",
      "expiresAtMs",
    ]);
    insist(
      body.operation === "grant" || body.operation === "revoke",
      "dance_invalid_operation",
    );
    return reply(
      await api.permissions.delegate(actor, danceId(body.commandId), {
        delegationId: danceId(body.delegationId),
        accountId: danceId(body.accountId),
        operation: body.operation,
        expiresAtMs: integer(body.expiresAtMs, 0, 8_000_000_000_000_000),
      }),
    );
  }
  if (match && match[2]) {
    const revision = integer(body.revision, 1, Number.MAX_SAFE_INTEGER),
      command = danceId(body.commandId);
    if (match[2] === "verdict") {
      const decoded = decodeDanceDecision(body);
      return reply(
        await api.decide(
          actor,
          decoded.commandId,
          match[1],
          decoded.revision,
          decoded.verdict,
          decoded.consentVersion,
        ),
      );
    }
    exact(body, ["commandId", "revision"]);
    return reply(
      await api.end(
        actor,
        command,
        match[1],
        revision,
        match[2] === "withdraw" ? "withdraw" : "expire",
      ),
    );
  }
  throw new CommunityError("dance_route_not_found", 404);
}
