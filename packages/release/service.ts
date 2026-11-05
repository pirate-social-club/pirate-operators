import type { PrivateKeyAccount } from "viem/accounts";
import type { PublicClient } from "viem";
import {
  CommunityError,
  exact,
  hashJson,
  insist,
  jsonBody,
  object,
  text,
} from "../community/common.ts";
import {
  authorizeServiceRequest,
  type ManagedPairing,
} from "../moderation/pairing.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import type { AdmissionMedia } from "../moderation/prepare-admission.ts";
import { reconcilePin, type IpfsTransport } from "../community/ipfs.ts";
import { establishRelease } from "./authority.ts";
import { validateReleaseGrant } from "./grant.ts";
import { fundedPin } from "./pin-operations.ts";
import { fundedRegistration } from "./registration-operations.ts";
import {
  pinOperationId,
  releaseArtifact,
  releaseRoles,
  retainedArtifact,
  type ReleaseRole,
} from "./artifacts.ts";

export interface ReleaseService {
  origin: string;
  grant: unknown;
  pairings: ManagedPairing[];
  currentConfiguration(pairing: ManagedPairing): Promise<CommunityConfig>;
  filebaseCredential: string;
  registrationSigner: PrivateKeyAccount;
  registrationClient: PublicClient;
  acrEndpoint: string;
  pinTransport?: IpfsTransport;
}
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
/** Publisher-authorized operations under one independently configured operator
 * grant. Input/metadata bytes and destinations are server-derived. */
export async function releaseFetch(
  request: Request,
  db: D1Database,
  media: AdmissionMedia,
  service: ReleaseService,
) {
  try {
    const url = new URL(request.url),
      routes = {
        "/v1/releases/pin": {
          action: "release_pin",
          kind: "pin",
          mode: "execute",
        },
        "/v1/releases/pin/status": {
          action: "release_pin_status",
          kind: "pin",
          mode: "reconcile",
        },
        "/v1/releases/register": {
          action: "release_register",
          kind: "register",
          mode: "execute",
        },
        "/v1/releases/register/status": {
          action: "release_register_status",
          kind: "register",
          mode: "reconcile",
        },
      } as const;
    const route = routes[url.pathname as keyof typeof routes];
    insist(
      url.origin === service.origin &&
        request.method === "POST" &&
        route &&
        !url.search,
      "not_found",
      404,
    );
    const { body, current, pairing, authorization } =
      await authorizeServiceRequest(
        db,
        await jsonBody(request),
        route.action,
        service.origin,
        service.pairings,
        service.currentConfiguration,
      );
    exact(body, route.kind === "pin" ? ["context", "role"] : ["context"]);
    const grant = validateReleaseGrant(service.grant);
    insist(
      service.registrationSigner.address.toLowerCase() ===
        grant.registration.operator,
      "release_operator_binding_unavailable",
      503,
    );
    const capturedConfig = hashJson(current),
      capturedPairing = hashJson(pairing);
    const authorizePurchase = async () => {
      const fresh = await service.currentConfiguration(pairing),
        active = service.pairings.find(
          (p) => p.communityId === pairing.communityId,
        );
      insist(
        active?.enabled && hashJson(active) === capturedPairing,
        "managed_pairing_changed",
        403,
      );
      insist(
        hashJson(fresh) === capturedConfig,
        "community_authority_changed",
        403,
      );
      const now = Math.floor(Date.now() / 1000);
      insist(
        grant.expiresAt > now && authorization.expiresAt > now,
        "release_grant_expired",
        403,
      );
    };
    const pinTransport: IpfsTransport = async (request) => {
      if (new URL(request.url).pathname === "/api/v0/add")
        await authorizePurchase();
      return service.pinTransport
        ? service.pinTransport(request)
        : fetch(request);
    };
    const registrationClient = {
      ...service.registrationClient,
      sendRawTransaction: async (
        parameters: Parameters<PublicClient["sendRawTransaction"]>[0],
      ) => {
        await authorizePurchase();
        return service.registrationClient.sendRawTransaction(parameters);
      },
    } as PublicClient;
    const release = await establishRelease(
      db,
      body.context,
      grant,
      current,
      service.acrEndpoint,
      Math.floor(Date.now() / 1000),
      route.mode,
    );
    if (!release) return reply({ state: "absent" }, 404);
    const operationReply = (operationId: string, result: { state: string }) =>
      reply(
        {
          schema: "pirate.managed-release-operation/1",
          operationId,
          grantSha256: grant.sha256,
          result,
        },
        result.state === "confirmed"
          ? 200
          : result.state === "absent"
            ? 404
            : 202,
      );
    if (route.kind === "pin") {
      const role = text(body.role, 32) as ReleaseRole;
      insist(releaseRoles.includes(role), "unsupported_release_artifact", 400);
      const artifact = await releaseArtifact(db, media, release, role);
      const result = await fundedPin(
        db,
        pinOperationId(grant.sha256, role),
        grant.pins,
        artifact.intent,
        artifact.bytes,
        service.filebaseCredential,
        pinTransport,
        route.mode,
      );
      return operationReply(pinOperationId(grant.sha256, role), result);
    }
    const registrationId = hashJson({
      grantHash: grant.sha256,
      kind: "root_registration",
    });
    if (route.mode === "reconcile") {
      const existing = await db
        .prepare("SELECT state FROM funded_registrations WHERE operation_id=?")
        .bind(registrationId)
        .first<{ state: string }>();
      if (
        !existing ||
        existing.state === "planned" ||
        existing.state === "prepared"
      )
        return operationReply(registrationId, { state: "absent" });
    }
    const [metadata, nft] = await Promise.all([
      retainedArtifact(db, grant.sha256, "ip_metadata"),
      retainedArtifact(db, grant.sha256, "nft_metadata"),
    ]);
    await Promise.all(
      [metadata, nft, await retainedArtifact(db, grant.sha256, "audio")].map(
        (pin) => reconcilePin(pin, service.filebaseCredential, pinTransport),
      ),
    );
    const result = await fundedRegistration(
      db,
      registrationId,
      grant.registration,
      {
        recipient: grant.registration.recipient,
        contentSha256: grant.registration.contentSha256,
        metadata: { uri: metadata.uri, sha256: metadata.sha256 },
        nftMetadata: { uri: nft.uri, sha256: nft.sha256 },
      },
      registrationClient,
      service.registrationSigner,
      route.mode,
    );
    return operationReply(registrationId, result);
  } catch (error) {
    return reply(
      {
        error:
          error instanceof CommunityError
            ? error.code
            : "release_service_unavailable",
      },
      error instanceof CommunityError ? error.status : 503,
    );
  }
}
