import type { PrivateKeyAccount } from "viem/accounts";
import { CommunityError, insist, object, publicId } from "./common.ts";
import { httpsOrigin } from "./manifest-core.ts";
import { readBounded } from "./ipfs.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import {
  signServiceRequest,
  type ServiceAuthorization,
} from "../moderation/pairing.ts";

export interface ManagedClient {
  origin: string;
  publisher: PrivateKeyAccount;
  configuration: CommunityConfig;
  transport?: (request: Request) => Promise<Response>;
}
/** Every server request is bound to the current community publisher, canonical
 * origin and complete body. Cookies and service/provider keys never cross it. */
export async function managedRequest(
  client: ManagedClient,
  path: string,
  action: ServiceAuthorization["action"],
  body: Record<string, unknown>,
) {
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
  const absent =
    response.status === 404 &&
    ((action === "status" && result.error === "admission_not_found") ||
      ((action === "release_pin_status" ||
        action === "release_register_status") &&
        (result.state === "absent" ||
          (result.schema === "pirate.managed-release-operation/1" &&
            object(result.result).state === "absent"))));
  if (!response.ok && !absent) {
    const code =
      typeof result.error === "string" &&
      /^[a-z0-9_]{1,100}$/.test(result.error)
        ? result.error
        : "managed_service_unavailable";
    throw new CommunityError(
      code,
      response.status >= 400 && response.status <= 599 ? response.status : 503,
    );
  }
  return { status: response.status, body: result };
}
