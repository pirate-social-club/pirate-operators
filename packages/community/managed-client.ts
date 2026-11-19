import type { PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";
import { bytes32, CommunityError, exact, hashJson, hashText, insist, integer, object, publicId, text } from "./common.ts";
import { httpsOrigin } from "./manifest-core.ts";
import { readBounded } from "./ipfs.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import type { ExternalOperation, PublicationJob } from "./publication-store.ts";
import {
  signServiceRequest,
  type ServiceAuthorization,
} from "../moderation/pairing.ts";

interface ProtectedManagedPinReference {
  jobId: string;
  operationId: Hex;
  requestHash: Hex;
  step: "pin_audio" | "pin_lyrics" | "pin_manifest";
}
export type ProtectedManagedPinRequest =
  | { purpose: "pin_status"; reference: ProtectedManagedPinReference }
  | { purpose: "pin"; reference: ProtectedManagedPinReference; initiatingLeaseSha256: Hex };
export type ProtectedManagedPin = (request: ProtectedManagedPinRequest) =>
  Promise<{ status: number; body: Record<string, unknown> }>;

export interface ManagedPinOriginal {
  operation: ExternalOperation;
  job?: PublicationJob;
}

interface ManagedClientScope {
  origin: string;
  configuration: CommunityConfig;
  transport?: (request: Request) => Promise<Response>;
}

export interface PublisherManagedClient extends ManagedClientScope {
  publisher: PrivateKeyAccount;
  protectedPin?: never;
}

export interface ProtectedManagedClient extends ManagedClientScope {
  protectedPin: ProtectedManagedPin;
  publisher?: never;
}

export type ManagedClient = PublisherManagedClient | ProtectedManagedClient;

function protectedPinRequest(
  path: string,
  action: ServiceAuthorization["action"],
  body: Record<string, unknown>,
  original?: ManagedPinOriginal,
): ProtectedManagedPinRequest {
  insist(action === "release_pin" || action === "release_pin_status", "protected_managed_pin_scope_unavailable", 503);
  const expectedPath = action === "release_pin" ? "/v1/owner-releases/pin" : "/v1/owner-releases/pin/status";
  insist(path === expectedPath && original, "protected_managed_pin_scope_unavailable", 503);
  exact(body, ["context", "role"]);
  const jobId = text(object(body.context).jobId, 128);
  const role = body.role;
  insist(role === "audio" || role === "lyrics" || role === "post_manifest", "protected_managed_pin_scope_unavailable", 503);
  const step = role === "post_manifest" ? "pin_manifest" : role === "audio" ? "pin_audio" : "pin_lyrics";
  const { operation, job } = original;
  insist(operation.job_id === jobId && operation.step === step && operation.operation_id === hashJson({ job: jobId, step }),
    "protected_managed_pin_scope_unavailable", 503);
  const reference: ProtectedManagedPinReference = {
    jobId, step, operationId: bytes32(operation.operation_id), requestHash: bytes32(operation.request_hash),
  };
  if (action === "release_pin_status") return { purpose: "pin_status", reference };
  insist(job?.job_id === jobId && job.phase === step && job.lease_token && Date.now() < job.lease_until,
    "protected_managed_pin_lease_unavailable", 503);
  return { purpose: "pin", reference, initiatingLeaseSha256: hashText(job.lease_token) };
}
/** Every server request is bound to the current community publisher, canonical
 * origin and complete body. Cookies and service/provider keys never cross it. */
export async function managedRequest(
  client: ManagedClient,
  path: string,
  action: ServiceAuthorization["action"],
  body: Record<string, unknown>,
  original?: ManagedPinOriginal,
) {
  if (client.protectedPin) {
    const response = await client.protectedPin(protectedPinRequest(path, action, body, original));
    return managedReply(integer(response.status, 100, 599), object(response.body), action);
  }
  const origin = httpsOrigin(client.origin),
    now = Math.floor(Date.now() / 1000),
    config = client.configuration;
  insist(
    client.publisher.address.toLowerCase() === config.publisher,
    "community_publisher_changed",
    503,
  );
  const signed = await signServiceRequest(
    client.publisher,
    {
      action,
      communityId: config.communityId,
      communityOrigin: config.app.origin,
      serviceOrigin: origin,
      configurationRevision: config.configurationRevision,
      nonce: publicId(),
      issuedAt: now,
      expiresAt: now + 300,
    },
    body,
  );
  const request = new Request(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed),
    redirect: "manual",
    signal: AbortSignal.timeout(60000),
  });
  const response = await (client.transport
    ? client.transport(request)
    : fetch(request));
  const result = object(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBounded(response, 2 * 1024 * 1024, false),
      ),
    ),
  );
  return managedReply(response.status, result, action);
}

function managedReply(status: number, result: Record<string, unknown>, action: ServiceAuthorization["action"]) {
  const absent =
    status === 404 &&
    ((action === "status" && result.error === "admission_not_found") ||
      ((action === "release_pin_status" ||
        action === "release_register_status") &&
        (result.state === "absent" ||
          (result.schema === "pirate.managed-release-operation/1" &&
            object(result.result).state === "absent"))));
  if ((status < 200 || status >= 300) && !absent) {
    const code =
      typeof result.error === "string" &&
      /^[a-z0-9_]{1,100}$/.test(result.error)
        ? result.error
        : "managed_service_unavailable";
    throw new CommunityError(
      code,
      status >= 400 && status <= 599 ? status : 503,
    );
  }
  return { status, body: result };
}
