import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { bytes32, canonical, exact, hashJson, integer, object } from "../../packages/community/common.ts";
import { checkedPublicationCapability, nativePublicationAuthorized } from "../../services/native-publication-reference.ts";
import {
  assertNativePostsDispatchProofCurrent, nativePostsDispatchPath, nativePostsObservationPath,
  nativePostsQuotePath, readNativePostsDispatchRequest, readNativePostsDispatchStatus,
  readNativePostsPublicationReference, readNativePostsPublicationStatus, readNativePostsQuote,
  type NativePostsDispatchRequest, type NativePostsPublicationReference,
} from "../../services/native-posts-publication.ts";
import { publicationResponseBytes } from "../../services/publication-app-documents.ts";
import { rawDigest, safeId, type OperationLease } from "./backend-state.ts";
import {
  assertIndependentTrustAnchors, canonicalPublicKeyIdentity, verifyRecord,
  type SignedRecord, type TrustAnchor,
} from "./installed-records.ts";
import type { ProtectedFirstSongRoute } from "./web2-protected-posts-mount.ts";

const bindingSchema = "pirate.stage-protected-posts-relay/1";
const requestSchema = "pirate.stage-protected-posts-request/1";
export const postsRelayReplySchema = "pirate.stage-protected-posts-reply/1";
export const postsRelayRequestLimit = 4096;
export const postsRelayReplyLimit = 8192;

type LeasePin = Readonly<{ installationId: string; operationId: string; leaseIntentSha256: string }>;
export type ProtectedPostsRelayBinding = Readonly<{
  schema: typeof bindingSchema;
  guest: LeasePin & Readonly<{ bootstrapSha256: Hex; sidecarSha256: Hex }>;
  owner: LeasePin & Readonly<{ journalId: Hex }>;
  publisher: Address;
  applicationOriginalSha256: Hex;
  grantSha256: Hex;
  reference: Readonly<NativePostsPublicationReference>;
  replyKeyIdentity: string;
  expiresAtMs: number;
}>;

export type ProtectedPostsRelaySelection = {
  selection: SignedRecord<ProtectedPostsRelayBinding>;
  selectionTrust: TrustAnchor;
  replyTrust: TrustAnchor;
};

const actions = {
  [nativePostsQuotePath]: "quote",
  [nativePostsDispatchPath]: "dispatch",
  [nativePostsObservationPath]: "observe",
} as const;
type Action = typeof actions[keyof typeof actions];

type CommonFrame = Readonly<{
  schema: typeof requestSchema;
  bindingSha256: Hex;
  challenge: string;
  expiresAtMs: number;
}>;
export type ProtectedPostsRelayFrame = CommonFrame & (
  | Readonly<{ action: "quote" | "observe"; body: Readonly<NativePostsPublicationReference> }>
  | Readonly<{ action: "dispatch"; body: Readonly<NativePostsDispatchRequest> }>
);
export type ProtectedPostsRelayReply = Readonly<{
  schema: typeof postsRelayReplySchema;
  bindingSha256: Hex;
  requestSha256: Hex;
  expiresAtMs: number;
  response: string;
}>;

function digest(value: unknown) {
  const result = bytes32(value);
  assert(value === result, "protected_posts_relay_digest_changed");
  return result;
}

function readLeasePin(row: Record<string, unknown>): LeasePin {
  assert(typeof row.installationId === "string" && row.installationId.length <= 128 &&
    typeof row.operationId === "string" && safeId(row.operationId) &&
    typeof row.leaseIntentSha256 === "string" && rawDigest(row.leaseIntentSha256), "protected_posts_relay_lease_invalid");
  return { installationId: row.installationId, operationId: row.operationId, leaseIntentSha256: row.leaseIntentSha256 };
}

export function assertPostsRelayLease(pin: LeasePin, lease: OperationLease) {
  assert(lease.installationId === pin.installationId && lease.operationId === pin.operationId &&
    lease.intentRef.sha256 === pin.leaseIntentSha256, "protected_posts_relay_lease_changed");
}

function signedRecord<T>(value: SignedRecord<T>) {
  exact(object(value), ["schema", "keyId", "body", "signature"]);
  return value;
}

export function readProtectedPostsRelaySelection(input: ProtectedPostsRelaySelection) {
  const replyTrust = Object.freeze({ ...input.replyTrust });
  assertIndependentTrustAnchors(input.selectionTrust, replyTrust);
  const row = object(verifyRecord(signedRecord(input.selection), input.selectionTrust));
  exact(row, ["schema", "guest", "owner", "publisher", "applicationOriginalSha256", "grantSha256",
    "reference", "replyKeyIdentity", "expiresAtMs"]);
  const guest = object(row.guest), owner = object(row.owner);
  exact(guest, ["installationId", "operationId", "leaseIntentSha256", "bootstrapSha256", "sidecarSha256"]);
  exact(owner, ["installationId", "operationId", "leaseIntentSha256", "journalId"]);
  assert(row.schema === bindingSchema && typeof row.publisher === "string" &&
    /^0x[0-9a-f]{40}(?![\s\S])/.test(row.publisher) && row.replyKeyIdentity === canonicalPublicKeyIdentity(replyTrust),
    "protected_posts_relay_selection_changed");
  const binding: ProtectedPostsRelayBinding = Object.freeze({
    schema: bindingSchema,
    guest: Object.freeze({ ...readLeasePin(guest), bootstrapSha256: digest(guest.bootstrapSha256),
      sidecarSha256: digest(guest.sidecarSha256) }),
    owner: Object.freeze({ ...readLeasePin(owner), journalId: digest(owner.journalId) }),
    publisher: row.publisher as Address,
    applicationOriginalSha256: digest(row.applicationOriginalSha256),
    grantSha256: digest(row.grantSha256),
    reference: readNativePostsPublicationReference(canonical(row.reference)),
    replyKeyIdentity: row.replyKeyIdentity as string,
    expiresAtMs: integer(row.expiresAtMs, 1, Number.MAX_SAFE_INTEGER),
  });
  assert(binding.guest.leaseIntentSha256 !== binding.owner.leaseIntentSha256 &&
    canonical(binding) === canonical(row), "protected_posts_relay_selection_changed");
  assertNativePostsDispatchProofCurrent(binding.expiresAtMs);
  return Object.freeze({ binding, bindingSha256: hashJson(binding), replyTrust });
}

type Selection = ReturnType<typeof readProtectedPostsRelaySelection>;
const duration = (action: Action) => action === "dispatch" ? 18_000 : 9_000;

function readBody(action: Action, raw: string, binding: ProtectedPostsRelayBinding) {
  if (action === "dispatch") {
    const body = readNativePostsDispatchRequest(raw);
    assert(canonical(body.reference) === canonical(binding.reference), "protected_posts_relay_original_changed");
    return { action, body };
  }
  const body = readNativePostsPublicationReference(raw);
  assert(canonical(body) === canonical(binding.reference), "protected_posts_relay_original_changed");
  return { action, body };
}

export function readProtectedPostsRelayFrame(raw: string, selection: Selection): ProtectedPostsRelayFrame {
  assert(Buffer.byteLength(raw) <= postsRelayRequestLimit, "protected_posts_relay_request_size");
  const row = object(JSON.parse(raw));
  exact(row, ["schema", "bindingSha256", "action", "body", "challenge", "expiresAtMs"]);
  const { schema, action, challenge, expiresAtMs } = row;
  assert(schema === requestSchema && row.bindingSha256 === selection.bindingSha256 &&
    (action === "quote" || action === "dispatch" || action === "observe") &&
    typeof challenge === "string" && /^[0-9a-f]{48}(?![\s\S])/.test(challenge) &&
    typeof expiresAtMs === "number" && expiresAtMs <= selection.binding.expiresAtMs &&
    expiresAtMs <= Date.now() + duration(action), "protected_posts_relay_frame_changed");
  assertNativePostsDispatchProofCurrent(expiresAtMs);
  const frame = { schema, bindingSha256: selection.bindingSha256, challenge, expiresAtMs,
    ...readBody(action, canonical(row.body), selection.binding) } as const;
  assert(canonical(frame) === raw, "protected_posts_relay_request_not_canonical");
  return Object.freeze(frame);
}

export function assertPostsRelayResponse(raw: string, frame: ProtectedPostsRelayFrame) {
  assert(Buffer.byteLength(raw) <= postsRelayReplyLimit, "protected_posts_relay_reply_size");
  if (frame.action === "dispatch") readNativePostsDispatchStatus(raw, frame.body);
  else if (frame.action === "quote") assertNativePostsDispatchProofCurrent(readNativePostsQuote(raw, frame.body).expiresAtMs);
  else readNativePostsPublicationStatus(raw, frame.body);
}

export const unavailablePostsRelay = () => new Response(null, { status: 503, headers: { "cache-control": "no-store" } });

/** The installed guest forwards three existing publication routes. Its lease
 * satisfies W6 listener identity. The owner holds the separate physical Store. */
export async function openProtectedPostsRelayGuest(input: ProtectedPostsRelaySelection & {
  lease: OperationLease;
  socket: string;
  forwardBearer: string;
  assertCurrent(binding: ProtectedPostsRelayBinding): Promise<void>;
  // This adapter must use the independently admitted owner endpoint and
  // provide bounded, cancellation-aware request and reply I/O.
  exchange(raw: string, signal: AbortSignal): Promise<string>;
}): Promise<ProtectedFirstSongRoute> {
  const selection = readProtectedPostsRelaySelection(input), { binding, bindingSha256, replyTrust } = selection;
  const { lease, socket } = input, forward = checkedPublicationCapability(input.forwardBearer);
  assertPostsRelayLease(binding.guest, lease);
  await lease.assertHeld();
  await input.assertCurrent(binding);
  assertNativePostsDispatchProofCurrent(binding.expiresAtMs);

  const closed = new AbortController(), pending = new Set<Promise<Response>>();
  async function relay(request: Request, action: Action) {
    try {
      assert(!closed.signal.aborted && request.method === "POST" && !request.headers.has("cookie") &&
        request.body && request.headers.get("content-type") === "application/json" &&
        await nativePublicationAuthorized(request, forward), "protected_posts_relay_guest_forbidden");
      const expiresAtMs = Math.min(binding.expiresAtMs, Date.now() + duration(action));
      assertNativePostsDispatchProofCurrent(expiresAtMs);
      const signal = AbortSignal.any([closed.signal, request.signal, AbortSignal.timeout(Math.max(0, expiresAtMs - Date.now()))]);
      const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await publicationResponseBytes(new Response(request.body, { headers: request.headers }), postsRelayRequestLimit));
      const body = readBody(action, raw, binding).body;
      const challenge = randomBytes(24).toString("hex");
      const frame = readProtectedPostsRelayFrame(
        canonical({ schema: requestSchema, bindingSha256, action, body, challenge, expiresAtMs }), selection);
      await lease.assertHeld();
      await input.assertCurrent(binding);
      signal.throwIfAborted();
      assertNativePostsDispatchProofCurrent(expiresAtMs);
      const replyRaw = await input.exchange(canonical(frame), signal);
      signal.throwIfAborted();
      assert(Buffer.byteLength(replyRaw) <= postsRelayReplyLimit, "protected_posts_relay_reply_size");
      const record = signedRecord(JSON.parse(replyRaw) as SignedRecord<ProtectedPostsRelayReply>);
      const reply = verifyRecord(record, replyTrust);
      exact(object(reply), ["schema", "bindingSha256", "requestSha256", "expiresAtMs", "response"]);
      assert(reply.schema === postsRelayReplySchema && reply.bindingSha256 === bindingSha256 &&
        reply.requestSha256 === hashJson(frame) && reply.expiresAtMs === expiresAtMs &&
        typeof reply.response === "string" && canonical(record) === replyRaw, "protected_posts_relay_reply_changed");
      await lease.assertHeld();
      await input.assertCurrent(binding);
      signal.throwIfAborted();
      assertNativePostsDispatchProofCurrent(expiresAtMs);
      assertPostsRelayResponse(reply.response, frame);
      return new Response(reply.response, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch {
      return unavailablePostsRelay();
    }
  }
  return {
    lease, socket,
    async fetch(request) {
      const { pathname, search } = new URL(request.url);
      if (!Object.hasOwn(actions, pathname)) return null;
      if (search) return unavailablePostsRelay();
      const work = relay(request, actions[pathname as keyof typeof actions]);
      pending.add(work);
      try { return await work; }
      finally { pending.delete(work); }
    },
    async close() {
      closed.abort();
      await Promise.allSettled(pending);
    },
  };
}
