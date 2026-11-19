import { keccak256, type Address, type Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import { consentAddress, consentDigest } from "../packages/protocol/publication-consent.ts";
import type { DanceV2OriginalLookup } from "./dance-v2-action-recovery.ts";
import { publicationResponseBytes } from "./publication-app-documents.ts";
import { exact, record } from "./publication-command-contract.ts";

export const nativeDanceHostPath = "/publication/v1/dance-retained";
export const nativeDanceDispatchPath = "/publication/v1/dance-dispatch";
export const nativeDanceDispatchReadyPath = "/_operator/native-publication/dance-dispatch-ready";
export const nativeDanceReadyPath = "/_operator/native-publication/dance-ready";
export const nativeDanceReplyLimit = 12 * 1024;
export { nativeDancePublisherHoldKey } from "./native-dance-publisher-hold-key.ts";

type Original = Parameters<DanceV2OriginalLookup["readRetainedAttempt"]>[0];
export type NativeDanceSigned = NonNullable<Awaited<ReturnType<DanceV2OriginalLookup["readRetainedAttempt"]>>>;
export interface NativeDanceRetainedScope {
  installationId: Hex;
  releaseSha256: Hex;
  chainId: 6343;
  communityId: Hex;
  verifier: Address;
  publisher: Address;
  sourceHash: Hex;
}
export interface NativeDanceRetainedReference {
  schema: "pirate.native-dance-retained-reference/1";
  installationId: Hex;
  releaseSha256: Hex;
  original: Original;
}

export function nativeDanceReference(value: unknown): NativeDanceRetainedReference {
  const v = record(value), o = record(v.original);
  exact(v, ["schema", "installationId", "releaseSha256", "original"]);
  exact(o, ["chainId", "communityId", "verifier", "publisher", "sourceHash", "kind", "resourceId", "commandId", "commandHash"]);
  check(v.schema === "pirate.native-dance-retained-reference/1" && o.chainId === 6343 &&
    (o.kind === "register" || o.kind === "verdict"), "native_dance_reference_invalid");
  return { schema: v.schema, installationId: consentDigest(v.installationId),
    releaseSha256: consentDigest(v.releaseSha256), original: {
      chainId: o.chainId, communityId: consentDigest(o.communityId), verifier: consentAddress(o.verifier),
      publisher: consentAddress(o.publisher), sourceHash: consentDigest(o.sourceHash), kind: o.kind,
      resourceId: consentDigest(o.resourceId), commandId: consentDigest(o.commandId), commandHash: consentDigest(o.commandHash),
    } };
}

export function assertNativeDanceScope(ref: NativeDanceRetainedReference, scope: NativeDanceRetainedScope) {
  const { original } = ref;
  check(ref.installationId === scope.installationId && ref.releaseSha256 === scope.releaseSha256 &&
    original.chainId === scope.chainId && original.communityId === scope.communityId &&
    original.verifier === scope.verifier && original.publisher === scope.publisher && original.sourceHash === scope.sourceHash,
    "native_dance_scope_changed");
}

export async function readNativeDanceReference(request: Request) {
  check(request.headers.get("content-type") === "application/json" && request.body, "native_dance_reference_invalid");
  const length = request.headers.get("content-length");
  const headers = length === null ? undefined : { "content-length": length };
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(
    await publicationResponseBytes(new Response(request.body, { headers }), 2048),
  );
  const ref = nativeDanceReference(JSON.parse(raw));
  check(raw === canonical(ref), "native_dance_reference_invalid");
  request.signal.throwIfAborted();
  return ref;
}

export function nativeDanceRaw(value: unknown): Hex {
  check(typeof value === "string" && value.length <= 8192 && /^0x(?:[0-9a-f]{2})+(?![\s\S])/.test(value),
    "native_dance_original_invalid");
  return `0x${value.slice(2)}`;
}
export function nativeDanceAttempt(value: unknown): NativeDanceSigned | null {
  if (value === null) return null;
  const r = record(value);
  exact(r, ["nonce", "hash", "raw"]);
  const raw = nativeDanceRaw(r.raw), hash = consentDigest(r.hash);
  check(typeof r.nonce === "number" && Number.isSafeInteger(r.nonce) && r.nonce >= 0 && keccak256(raw) === hash,
    "native_dance_original_invalid");
  return { nonce: r.nonce, hash, raw };
}

export function nativeDanceResponse(ref: NativeDanceRetainedReference, result: unknown) {
  return new Response(canonical({ reference: digest(ref), result }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
export function nativeDanceReply(raw: string, ref: NativeDanceRetainedReference): unknown {
  const body = record(JSON.parse(raw));
  exact(body, ["reference", "result"]);
  check(raw === canonical(body) && body.reference === digest(ref), "native_dance_reply_changed");
  return body.result;
}
