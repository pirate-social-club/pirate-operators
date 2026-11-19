import { bytes32, canonical, exact, hashJson, insist, integer, object, text } from "../packages/community/common.ts";
import { nativeDigest, verifyNativeRecord } from "../packages/community/native-business-binding.ts";
import type { Web2NativeOriginal } from "../packages/community/web2-native-business-binding.ts";
import type { ProtectedManagedPin } from "../packages/community/managed-client.ts";
import type { SignedRecord } from "../deploy/linux/installed-records.ts";
import type { OwnerBudgetGrant } from "../packages/release/owner-grant.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import { readCanonicalBytes, type CanonicalWireRequest } from "../packages/recognition/canonical-protocol.ts";
import { checkedPublicationCapability, nativePublicationAuthorized, publicationHostOrigin } from "./native-publication-reference.ts";
import {
  nativePostsDispatchReadyPath, nativePostsPublicationResponse, nativePostsQuoteReadyPath,
  nativePostsCatalogResponsePath,
  readNativePostsDispatchRequest, readNativePostsPublicationReference,
} from "./native-posts-publication.ts";
import { publicationResponseBytes } from "./publication-app-documents.ts";
import type { ProtectedPostsJobTransport } from "./protected-posts-job.ts";
import type { ProtectedCatalogTransport } from "./protected-catalog-reservation.ts";
import { readProtectedPostsPlanned, readProtectedPostsReady } from "./protected-posts-ready.ts";

export interface Web2ProtectedPostsBindings {
  WEB2_PROTECTED_POSTS_OWNER?: Fetcher;
  WEB2_PROTECTED_POSTS_SELECTION_JSON?: string;
  WEB2_PROTECTED_POSTS_FORWARD_AUTH?: string;
  WEB2_PROTECTED_POSTS_REVERSE_AUTH?: string;
}

export function hasProtectedPostsBindings(env: Web2ProtectedPostsBindings) {
  return env.WEB2_PROTECTED_POSTS_SELECTION_JSON !== undefined ||
    env.WEB2_PROTECTED_POSTS_OWNER !== undefined ||
    env.WEB2_PROTECTED_POSTS_FORWARD_AUTH !== undefined ||
    env.WEB2_PROTECTED_POSTS_REVERSE_AUTH !== undefined;
}

export async function bindInstalledProtectedPosts(env: Web2ProtectedPostsBindings, original: Web2NativeOriginal) {
  if (!hasProtectedPostsBindings(env)) return;
  const host = env.WEB2_PROTECTED_POSTS_OWNER, selectionJson = env.WEB2_PROTECTED_POSTS_SELECTION_JSON;
  const ownerAuth = env.WEB2_PROTECTED_POSTS_FORWARD_AUTH, primaryAuth = env.WEB2_PROTECTED_POSTS_REVERSE_AUTH;
  insist(host && selectionJson && selectionJson.length <= 16_384 &&
    ownerAuth && primaryAuth && ownerAuth !== primaryAuth, "protected_posts_mount_incomplete", 503);
  const selectedHost = host;
  const forward = checkedPublicationCapability(ownerAuth), reverse = checkedPublicationCapability(primaryAuth);
  const selection = object(JSON.parse(selectionJson));
  exact(selection, ["selection", "expiresAtMs"]);
  const signed = object(selection.selection);
  exact(signed, ["schema", "keyId", "body", "signature"]);
  insist(signed.schema === "pirate.local-signed-record/1" &&
    typeof signed.keyId === "string" && typeof signed.signature === "string", "protected_posts_mount_incomplete", 503);
  const record: SignedRecord<unknown> = {
    schema: signed.schema, keyId: signed.keyId, body: signed.body, signature: signed.signature,
  };
  await verifyNativeRecord(record, original.trust);
  const pins = object(signed.body);
  exact(pins, ["schema", "transportRef", "hostInstallationId", "installationId", "applicationOriginalSha256",
    "releaseSha256", "configurationSha256", "grantSha256"]);
  text(pins.transportRef, 192);
  const applicationOriginalSha256 = bytes32(pins.applicationOriginalSha256);
  const releaseSha256 = bytes32(pins.releaseSha256);
  const installationId = bytes32(pins.installationId);
  const configurationSha256 = bytes32(pins.configurationSha256);
  const grantSha256 = bytes32(pins.grantSha256);
  insist(pins.schema === "pirate.web2-protected-posts-mount/1" &&
    pins.hostInstallationId === original.record.body.installationId &&
    installationId === original.record.body.draft.deployment.directoryProfile.installationId &&
    applicationOriginalSha256 === "0x" + nativeDigest(original) && releaseSha256 === hashJson(original.release.body),
  "protected_posts_mount_original_changed", 503);
  const expiresAtMs = integer(selection.expiresAtMs, 1, Number.MAX_SAFE_INTEGER);
  const assertCurrent = () => {
    insist(Date.now() < expiresAtMs &&
      env.WEB2_PROTECTED_POSTS_OWNER === host && env.WEB2_PROTECTED_POSTS_FORWARD_AUTH === ownerAuth &&
      env.WEB2_PROTECTED_POSTS_REVERSE_AUTH === primaryAuth && env.WEB2_PROTECTED_POSTS_SELECTION_JSON === selectionJson,
    "protected_posts_mount_changed", 503);
  };
  assertCurrent();
  async function exchange(path: string, body: string, signal: AbortSignal) {
    assertCurrent();
    const response = await selectedHost.fetch(new Request(publicationHostOrigin + path, {
      method: "POST", body, redirect: "manual", signal,
      headers: { authorization: "Bearer " + forward, "content-type": "application/json" },
    }));
    signal.throwIfAborted();
    assertCurrent();
    return response;
  }
  const posts = Object.freeze<ProtectedPostsJobTransport>({ installationId, releaseSha256, exchange });
  const catalog = Object.freeze<ProtectedCatalogTransport>({ installationId, releaseSha256, exchange });
  const protectedPin: ProtectedManagedPin = async (command) => {
    const request = { ...command, version: "pirate.protected-managed-http/1",
      reference: { installationId, releaseSha256, ...command.reference } };
    const signal = AbortSignal.timeout(60_000);
    const response = await exchange("/publication/v1/managed-request", canonical(request), signal);
    insist(response.status === 200 && response.headers.get("content-type") === "application/json",
      "protected_managed_pin_unavailable", 503);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(await publicationResponseBytes(response, 2 * 1024 * 1024));
    const reply = object(JSON.parse(raw));
    exact(reply, ["reference", "status", "body"]);
    insist(raw === canonical(reply) && reply.reference === hashJson(request), "protected_managed_pin_reply_changed", 503);
    signal.throwIfAborted();
    assertCurrent();
    return { status: integer(reply.status, 100, 599), body: object(reply.body) };
  };
  return Object.freeze({
    posts, catalog, protectedPin, reverse, assertCurrent,
    respond: (wire: CanonicalWireRequest, signal: AbortSignal) => exchange(nativePostsCatalogResponsePath, canonical(wire), signal),
    scope(db: D1Database, configuration: Web2CommunityConfig, ownerGrant: OwnerBudgetGrant,
      managedOrigin: string, maximumTotalFee: string) {
      assertCurrent();
      insist(configuration.chainId === 6343 && configuration.configurationRevision === 1 &&
        configuration.installationId === installationId && hashJson(configuration) === configurationSha256 &&
        ownerGrant.sha256 === grantSha256, "protected_posts_mount_authority_changed", 503);
      return { db, applicationOriginalSha256, releaseSha256, configuration, managedOrigin, ownerGrant, maximumTotalFee, expiresAtMs };
    },
  });
}

type PrimaryMount = {
  origin: string;
  reverse: string;
  assertCurrent?(): void;
  open(): Promise<{
    scope: Parameters<typeof readProtectedPostsPlanned>[0];
    revalidate: Parameters<typeof readProtectedPostsPlanned>[2];
    assertCurrent?(): void;
  }>;
};

export async function protectedPostsPrimaryFetch(request: Request, mount: PrimaryMount | undefined) {
  const url = new URL(request.url), path = url.pathname;
  if (!mount || url.origin !== mount.origin || url.search || request.method !== "POST" ||
    (path !== nativePostsQuoteReadyPath && path !== nativePostsDispatchReadyPath) ||
    request.headers.get("content-type") !== "application/json" || request.headers.has("cookie") ||
    !await nativePublicationAuthorized(request, mount.reverse))
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(await readCanonicalBytes(request, 4096, signal));
    signal.throwIfAborted();
    const planned = path === nativePostsQuoteReadyPath;
    const dispatch = planned ? undefined : readNativePostsDispatchRequest(raw);
    const reference = dispatch?.reference ?? readNativePostsPublicationReference(raw);
    const { scope, revalidate, assertCurrent } = await mount.open();
    const proof = dispatch ?
      await readProtectedPostsReady(scope, dispatch, revalidate) : await readProtectedPostsPlanned(scope, reference, revalidate);
    request.signal.throwIfAborted();
    mount.assertCurrent?.();
    assertCurrent?.();
    return nativePostsPublicationResponse(reference, proof);
  } catch {
    return Response.json({ error: "protected_posts_primary_unavailable" }, {
      status: 503, headers: { "cache-control": "no-store" },
    });
  }
}
