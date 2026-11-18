import type { Address, PublicClient } from "viem";
import { canonical, exact, insist, object } from "../packages/community/common.ts";
import { trustedWeb2PublicationReadbackPath } from "../packages/community/web2-trusted-publication.ts";
import { nativeDigest, verifyNativeRecord } from "../packages/community/native-business-binding.ts";
import { consentAddress, consentUint64 } from "../packages/protocol/publication-consent.ts";
import type { SignedRecord } from "../deploy/linux/installed-records.ts";
import { web2ApplicationOriginal, type ApplicationNativeEnv } from "./application-native-readback.ts";
import {
  isWeb2Deployment, readCommunityDeploymentProfile, type Web2CommunityDeploymentProfile,
} from "./community-deployment-profile.ts";
import { megaethReadClient } from "../packages/community/chain.ts";
import {
  checkedPublicationCapability,
  nativePublicationAuthorized,
  nativePublicationOperatorTransport,
  nativePublicationRetainedLookup,
  publicationLookupPath,
} from "./native-publication-reference.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";
import { publicationSelectionHash, type PublicationAppRelease } from "./publication-app-selection.ts";
import { loadPublicationInstallation, type PublicationMountIdentity } from "./publication-installed-selection.ts";

export interface NativePublicationApplicationEnv extends ApplicationNativeEnv {
  COMMUNITY_DEPLOYMENT_PROFILE_JSON?: string;
  PUBLICATION_NATIVE_MOUNT_JSON?: string;
  PUBLICATION_OPERATOR_HOST?: Pick<Fetcher, "fetch">;
  PUBLICATION_OPERATOR_HOST_AUTH?: string;
  PUBLICATION_RETAINED_LOOKUP_AUTH?: string;
  WEB2_PUBLISHING_ATTACHMENT_SHA256?: string;
}

export interface NativePublicationMountSelection {
  schema: "pirate.web2-native-publication-mount/1";
  nativeOriginalSha256: string;
  mount: PublicationMountIdentity;
  transportRef: string;
  // The signed graph producer and Node host resolve the independent issuer
  // capability by this reference. Workerd receives only its pinned address.
  issuerCapabilityRef: string;
  issuerAddress: Address;
}

// Only a completed native mount can authorize a reusable publication port.
// Cloning the port or building an independent transport does not brand it.
const mountedPorts = new WeakMap<PublicationApplicationPorts, (
  env: NativePublicationApplicationEnv, deployment: Web2CommunityDeploymentProfile,
) => Promise<void>>();

export async function reuseNativePublicationApplication(
  env: NativePublicationApplicationEnv,
  deployment: Web2CommunityDeploymentProfile,
  publication: PublicationApplicationPorts,
) {
  const assertMount = mountedPorts.get(publication);
  insist(assertMount, "native_publication_mount_unavailable", 503);
  try {
    await assertMount(env, deployment);
    return publication;
  } catch {
    insist(false, "native_publication_mount_unavailable", 503);
  }
}

export function hasNativePublicationBindings(env: NativePublicationApplicationEnv) {
  return env.PUBLICATION_NATIVE_MOUNT_JSON !== undefined ||
    env.PUBLICATION_OPERATOR_HOST !== undefined ||
    env.PUBLICATION_OPERATOR_HOST_AUTH !== undefined ||
    env.PUBLICATION_RETAINED_LOOKUP_AUTH !== undefined;
}

/** Trusted native graph supplies both directions and a mount signed under the
 * existing on-install trust. Do not use a request value or the latest D1 row
 * to choose the mount. The client is the application's deployment reader. */
export async function openNativePublicationApplication(
  env: NativePublicationApplicationEnv,
  deployment: Web2CommunityDeploymentProfile,
  client: PublicClient,
) {
  const installBytes = env.PUBLICATION_NATIVE_MOUNT_JSON;
  const host = env.PUBLICATION_OPERATOR_HOST;
  const forward = env.PUBLICATION_OPERATOR_HOST_AUTH;
  const reverse = env.PUBLICATION_RETAINED_LOOKUP_AUTH;
  const nativeBytes = env.NATIVE_APPLICATION_ORIGINAL_JSON;
  const attachment = env.WEB2_PUBLISHING_ATTACHMENT_SHA256;
  const db = env.DB;
  try {
    insist(installBytes && installBytes.length <= 8192 && host && typeof host.fetch === "function" &&
      forward && reverse && forward !== reverse && nativeBytes &&
      client.transport.url === deployment.rpcUrl,
      "native_publication_mount_required", 503);
    checkedPublicationCapability(forward);
    checkedPublicationCapability(reverse);
    function assertBindings(current = env) {
      insist(current.DB === db && current.PUBLICATION_NATIVE_MOUNT_JSON === installBytes &&
        current.PUBLICATION_OPERATOR_HOST === host && current.PUBLICATION_OPERATOR_HOST_AUTH === forward &&
        current.PUBLICATION_RETAINED_LOOKUP_AUTH === reverse &&
        current.NATIVE_APPLICATION_ORIGINAL_JSON === nativeBytes &&
        current.WEB2_PUBLISHING_ATTACHMENT_SHA256 === attachment,
        "native_publication_bindings_changed", 503);
    }
    const original = await web2ApplicationOriginal(env);
    assertBindings();
    insist(canonical(original.record.body.draft.deployment) === canonical(deployment) &&
      original.record.body.publishingAttachmentDigest === attachment,
      "native_publication_original_changed", 503);
    const signed: SignedRecord<NativePublicationMountSelection> = JSON.parse(installBytes);
    await verifyNativeRecord(signed, original.trust);
    assertBindings();
    const selected = signed.body;
    const originalSha256 = nativeDigest(original);
    exact(object(selected), ["schema", "nativeOriginalSha256", "mount",
      "transportRef", "issuerCapabilityRef", "issuerAddress"]);
    insist(selected.schema === "pirate.web2-native-publication-mount/1" &&
      selected.nativeOriginalSha256 === originalSha256 &&
      typeof selected.transportRef === "string" && /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/.test(selected.transportRef) &&
      typeof selected.issuerCapabilityRef === "string" && /^[a-zA-Z0-9_.:-]{1,256}(?![\s\S])/.test(selected.issuerCapabilityRef),
      "native_publication_mount_changed", 503);
    const issuer = consentAddress(selected.issuerAddress);
    const installation = await loadPublicationInstallation(db, selected.mount);
    assertBindings();
    const profile = deployment.directoryProfile;
    const pinned = installation.expected;
    insist(pinned.communityId === profile.communityId && pinned.installationId === profile.installationId &&
      pinned.origin === deployment.origin &&
      pinned.installedBindingSha256 === "0x" + originalSha256,
      "native_publication_mount_changed", 503);

    function assertRelease(release: PublicationAppRelease) {
      assertBindings();
      insist(installation.transportFor(publicationSelectionHash(release)) === selected.transportRef &&
        release.issuer === issuer, "native_publication_release_transport_changed", 503);
    }
    const publication: PublicationApplicationPorts = Object.freeze({
      db, installation, catalog: installation.catalog, client,
      transport: nativePublicationOperatorTransport(host, forward, assertRelease),
      nowMs: Date.now,
      clock: {
        now: () => BigInt(Math.floor(Date.now() / 1000)),
        maxSafeBlockAgeSeconds: consentUint64(deployment.freshness.maxSafeBlockAgeSeconds),
      },
      retryDelayMs: 250, observationDelayMs: 500,
      documentTimeoutMs: 5000, maxDocumentBytes: 65536,
    });
    const deploymentBytes = canonical(deployment);
    mountedPorts.set(publication, async (current, currentDeployment) => {
      assertBindings();
      assertBindings(current);
      insist(canonical(currentDeployment) === deploymentBytes, "native_publication_mount_changed", 503);
      await installation.check();
      assertBindings();
      assertBindings(current);
    });
    return {
      publication,
      async lookup(request: Request) {
        const response = await nativePublicationRetainedLookup(request, publication, reverse!, assertRelease);
        assertBindings();
        return response;
      },
    };
  } catch {
    // Keep private graph details and capabilities out of route errors.
    insist(false, "native_publication_mount_unavailable", 503);
  }
}

const unavailable = (status: number) => new Response(null, {
  status, headers: { "cache-control": "no-store" },
});

/** Exact private Linux application route behind the existing /_operator
 * exclusion. Authenticate before looking up signed mount or command state. */
export async function nativePublicationLookupFetch(
  request: Request,
  env: NativePublicationApplicationEnv,
) {
  const url = new URL(request.url);
  const reverse = env.PUBLICATION_RETAINED_LOOKUP_AUTH;
  if (url.pathname !== publicationLookupPath || url.search ||
    request.method !== "POST" || request.headers.has("X-Pirate-Native-Request") ||
    !reverse || !/^[a-f0-9]{64}(?![\s\S])/.test(reverse) ||
    !await nativePublicationAuthorized(request, reverse)) return unavailable(404);
  try {
    const deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON ?? "");
    if (!isWeb2Deployment(deployment) || url.origin !== deployment.origin) return unavailable(404);
    const mount = await openNativePublicationApplication(
      env, deployment, megaethReadClient(undefined, deployment.rpcUrl),
    );
    if (env.PUBLICATION_RETAINED_LOOKUP_AUTH !== reverse) return unavailable(404);
    return await mount.lookup(request);
  } catch {
    return unavailable(503);
  }
}


/** Private live selector readback. The installed gateway authenticates the
 * same readback capability and contributes its own current startup boot ID. */
export async function nativePublicationSelectionReadback(request: Request, env: NativePublicationApplicationEnv) {
  const url = new URL(request.url), key = env.NATIVE_READBACK_KEY;
  const supplied = request.headers.get("X-Pirate-Readback-Key");
  if (url.pathname !== trustedWeb2PublicationReadbackPath || url.search || url.hash ||
    request.method !== "GET" || !key || !/^[a-f0-9]{64}(?![\s\S])/.test(key) || !supplied ||
    !await nativePublicationAuthorized(new Request(request.url, {
      headers: { Authorization: "Bearer " + supplied }, signal: request.signal,
    }), key)) return unavailable(404);
  try {
    const deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON ?? "");
    if (!isWeb2Deployment(deployment) || url.origin !== deployment.origin) return unavailable(404);
    const { publication } = await openNativePublicationApplication(
      env, deployment, megaethReadClient(undefined, deployment.rpcUrl),
    );
    const installation = publication.installation, active = publication.catalog.active;
    insist(installation && active, "native_publication_mount_unavailable", 503);
    await reuseNativePublicationApplication(env, deployment, publication);
    if (env.NATIVE_READBACK_KEY !== key || request.signal.aborted) return unavailable(404);
    return Response.json({ mount: installation.expected, active }, { headers: { "cache-control": "no-store" } });
  } catch {
    return unavailable(503);
  }
}
