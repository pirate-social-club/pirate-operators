import type { Address, Hex } from "viem";
import { bytes32, canonical, exact, hashJson, insist, integer, object, text } from "./common.ts";
import type { LocalPostsScope } from "./local-posts-custody.ts";
import { address, ipfsUri } from "./manifest-core.ts";
import type { FirstPublication } from "./post-chain.ts";

export const nativePostsCustodyPath = "/_operator/native-posts-custody";
export const nativePostsRequestLimit = 1024;
export const nativePostsReplyLimit = 32 * 1024;
export const nativePostsOriginalLimit = 32;

export interface NativePostsCustodySelection {
  schema: "pirate.native-posts-custody-selection/1";
  hostInstallationId: string;
  originalSha256: Hex;
  releaseSelectionSha256: Hex;
  scope: LocalPostsScope & { readonly native: NonNullable<LocalPostsScope["native"]> };
}

function fixtureEndpoint(raw: unknown, originOnly: boolean) {
  const value = text(raw, 512);
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  insist(
    (loopback || url.hostname.endsWith(".example") || url.hostname.endsWith(".test")) &&
      url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
      (originOnly ? url.origin === value : url.href === value && url.pathname !== "/"),
    "native_posts_fixture_endpoint_changed",
    503,
  );
  return value;
}

export function parseNativePostsCustodySelection(raw: string): NativePostsCustodySelection {
  insist(raw.length <= 4096, "native_posts_selection_too_large", 503);
  const value = object(JSON.parse(raw));
  exact(value, ["schema", "hostInstallationId", "originalSha256", "releaseSelectionSha256", "scope"]);
  insist(value.schema === "pirate.native-posts-custody-selection/1", "native_posts_selection_invalid", 503);
  const scope = object(value.scope);
  exact(scope, ["chainId", "genesisHash", "rpcUrl", "publisher", "installationId", "communityId", "origin", "native"]);
  const native = object(scope.native);
  exact(native, ["applicationRpcUrl", "fixtureTransportSha256"]);
  const rpcUrl = text(scope.rpcUrl, 48);
  const installationId = text(scope.installationId, 128);
  const hostInstallationId = text(value.hostInstallationId, 200);
  insist(
    scope.chainId === 6343 && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}(?![\s\S])/.test(rpcUrl) &&
      new URL(rpcUrl).origin === rpcUrl &&
      /^[a-zA-Z0-9_-]{1,128}(?![\s\S])/.test(installationId) &&
      hostInstallationId.length > 0 && !/[\x00-\x1f\x7f]/.test(hostInstallationId),
    "native_posts_fixture_scope_required",
    503,
  );
  const selected: NativePostsCustodySelection = {
    schema: value.schema,
    hostInstallationId,
    originalSha256: bytes32(value.originalSha256),
    releaseSelectionSha256: bytes32(value.releaseSelectionSha256),
    scope: {
      chainId: 6343, genesisHash: bytes32(scope.genesisHash),
      rpcUrl, publisher: address(scope.publisher), installationId,
      communityId: bytes32(scope.communityId),
      origin: fixtureEndpoint(scope.origin, true),
      native: {
        applicationRpcUrl: fixtureEndpoint(native.applicationRpcUrl, false),
        fixtureTransportSha256: bytes32(native.fixtureTransportSha256),
      },
    },
  };
  insist(canonical(selected) === raw, "native_posts_selection_not_canonical", 503);
  return selected;
}

export interface NativePostsPublisherSelection {
  chainId: 6343;
  rpcUrl: string;
  genesisHash: Hex;
  publisher: Address;
  communityId: Hex;
  installationId: string;
  releaseSelectionSha256: Hex;
}
export interface NativePostsPublisherLease {
  assertHeldAndPostsQuiescent(): Promise<void>;
  release(outcome: "clear" | "reconcile"): Promise<void>;
}
export interface NativePostsAnchor {
  number: string;
  hash: Hex;
}
export interface NativePostsObservation {
  snapshot: Hex;
  anchor: NativePostsAnchor;
}
export interface NativePostsOriginal {
  hash: Hex;
  resultSha256: Hex;
  publication: FirstPublication;
}

type NativePostsRequest = {
  schema: "pirate.native-posts-custody/1";
  selection: Hex;
  holder: string;
} & ({
  action: "pause" | "inventory" | "reconcile";
} | {
  action: "hold" | "verify" | "clear";
  proof: NativePostsObservation;
});

export type NativePostsAction =
  | Pick<Extract<NativePostsRequest, { action: "pause" | "inventory" | "reconcile" }>, "action">
  | Pick<Extract<NativePostsRequest, { action: "hold" | "verify" | "clear" }>, "action" | "proof">;

export function nativePostsObservation(raw: unknown): NativePostsObservation {
  const value = object(raw);
  exact(value, ["snapshot", "anchor"]);
  const anchor = object(value.anchor);
  exact(anchor, ["hash", "number"]);
  const number = text(anchor.number, 20);
  insist(/^(0|[1-9][0-9]*)(?![\s\S])/.test(number) && BigInt(number) < 1n << 64n, "native_posts_anchor_invalid", 503);
  return { snapshot: bytes32(value.snapshot), anchor: { number, hash: bytes32(anchor.hash) } };
}

export function nativePostsRequest(raw: unknown): NativePostsRequest {
  const value = object(raw);
  const holder = text(value.holder, 64);
  insist(value.schema === "pirate.native-posts-custody/1" && /^[a-f0-9]{64}(?![\s\S])/.test(holder),
    "native_posts_request_invalid");
  const base = { schema: "pirate.native-posts-custody/1" as const, selection: bytes32(value.selection), holder };
  if (value.action === "pause" || value.action === "inventory" || value.action === "reconcile") {
    exact(value, ["schema", "selection", "holder", "action"]);
    return { ...base, action: value.action };
  }
  exact(value, ["schema", "selection", "holder", "action", "proof"]);
  insist(value.action === "hold" || value.action === "verify" || value.action === "clear", "native_posts_request_invalid");
  return { ...base, action: value.action, proof: nativePostsObservation(value.proof) };
}

export function nativePostsOriginal(raw: unknown): NativePostsOriginal {
  const value = object(raw);
  exact(value, ["hash", "publication", "resultSha256"]);
  const original = object(value.publication);
  exact(original, ["communityId", "postId", "configurationRevision", "authorId", "manifestSha256", "manifestURI"]);
  return {
    hash: bytes32(value.hash),
    resultSha256: bytes32(value.resultSha256),
    publication: {
      communityId: bytes32(original.communityId), postId: bytes32(original.postId),
      configurationRevision: integer(original.configurationRevision, 1, Number.MAX_SAFE_INTEGER),
      authorId: bytes32(original.authorId), manifestSha256: bytes32(original.manifestSha256),
      manifestURI: ipfsUri(original.manifestURI),
    },
  };
}

export function nativePostsSelectionHash(selection: NativePostsCustodySelection) {
  return hashJson(selection);
}
