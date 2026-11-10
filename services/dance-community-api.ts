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

export interface DanceCommunityPorts {
  db: D1Database;
  dance: DancePorts;
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
