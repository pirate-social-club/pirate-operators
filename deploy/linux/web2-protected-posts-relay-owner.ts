import assert from "node:assert/strict";
import { canonical, hashJson } from "../../packages/community/common.ts";
import {
  assertNativePostsDispatchProofCurrent, nativePostsPublicationResponse,
  type NativePostsDispatchRequest,
} from "../../services/native-posts-publication.ts";
import { signRecord } from "./installed-records.ts";
import { createNativePostsSender } from "./web2-native-posts-sender.ts";
import {
  assertPostsRelayLease, assertPostsRelayResponse, postsRelayReplyLimit, postsRelayReplySchema,
  readProtectedPostsRelayFrame, readProtectedPostsRelaySelection,
  type ProtectedPostsRelayBinding, type ProtectedPostsRelayReply, type ProtectedPostsRelaySelection,
} from "./web2-protected-posts-relay.ts";

type SenderInputs = Parameters<typeof createNativePostsSender>[0];
type ReverseReply = Readonly<{ status: number; contentType: string | null; raw: string }>;

/** This constructor belongs in the independent physically admitted owner.
 * There is no signing-only endpoint. The original Store process signs, fsyncs,
 * binds the catalog, records uncertain results and calls its own chain fetch. */
export async function openProtectedPostsRelayOwner<Peer>(input: ProtectedPostsRelaySelection & {
  sender: SenderInputs;
  assertOwnerCurrent(binding: ProtectedPostsRelayBinding): Promise<void>;
  authenticatePeer(peer: Peer, binding: ProtectedPostsRelayBinding, signal: AbortSignal): Promise<void>;
  assertCurrentSync(peer: Peer, binding: ProtectedPostsRelayBinding): true;
  // Authenticated primary dispatch-ready reader. The installed owner selects
  // the reverse endpoint and role from retained authority, outside the frame.
  readDispatchReady(request: Readonly<NativePostsDispatchRequest>, signal: AbortSignal): Promise<ReverseReply>;
  withReplyIssuer<T>(use: (privateKey: Uint8Array) => T): Promise<T>;
}) {
  const selection = readProtectedPostsRelaySelection(input), { binding, bindingSha256, replyTrust } = selection;
  const { lease, chain, scope, storeIdentity } = input.sender;
  assertPostsRelayLease(binding.owner, lease);
  assert(chain.publisher === binding.publisher && storeIdentity.journalId === binding.owner.journalId &&
    scope.installationId === binding.reference.installationId && scope.releaseSha256 === binding.reference.releaseSha256 &&
    scope.applicationOriginalSha256 === binding.applicationOriginalSha256 && scope.grantSha256 === binding.grantSha256 &&
    binding.expiresAtMs <= scope.expiresAtMs, "protected_posts_relay_owner_scope_changed");
  await lease.assertHeld();
  await input.assertOwnerCurrent(binding);
  assertNativePostsDispatchProofCurrent(binding.expiresAtMs);
  const sender = await createNativePostsSender(input.sender);

  const closed = new AbortController(), pending = new Set<Promise<string>>();
  async function accept(raw: string, peer: Peer, incoming: AbortSignal) {
    const frame = readProtectedPostsRelayFrame(raw, selection);
    const { action, body, expiresAtMs } = frame;
    const signal = AbortSignal.any([closed.signal, incoming, AbortSignal.timeout(Math.max(0, expiresAtMs - Date.now()))]);
    function assertCurrent() {
      signal.throwIfAborted();
      assert(input.assertCurrentSync(peer, binding) === true, "protected_posts_relay_authority_unavailable");
      signal.throwIfAborted();
      assertNativePostsDispatchProofCurrent(expiresAtMs);
      return true as const;
    }
    await lease.assertHeld();
    await input.assertOwnerCurrent(binding);
    await input.authenticatePeer(peer, binding, signal);
    assertCurrent();
    const reference = action === "dispatch" ? body.reference : body;
    const request = { reference, signal, assertHostCurrent: assertCurrent };
    const response = action === "dispatch"
      ? nativePostsPublicationResponse(reference, {
        ...await sender.execute({ ...request, ...body, dispatchNotAfterMs: expiresAtMs,
          revalidate: () => input.readDispatchReady(body, signal) }),
        quoteSha256: body.quoteSha256, initiatingLeaseSha256: body.initiatingLeaseSha256,
      })
      : nativePostsPublicationResponse(reference, action === "quote" ? await sender.quote(request) : await sender.observe(request));
    const responseRaw = await response.text();
    assertPostsRelayResponse(responseRaw, frame);
    const reply: ProtectedPostsRelayReply = Object.freeze({
      schema: postsRelayReplySchema, bindingSha256, requestSha256: hashJson(frame), expiresAtMs, response: responseRaw,
    });
    await lease.assertHeld();
    await input.assertOwnerCurrent(binding);
    let signed: string | undefined;
    const result = await input.withReplyIssuer(key => {
      assert(!signed, "protected_posts_relay_reply_issuer_reentered");
      assertCurrent();
      signed = canonical(signRecord(reply, replyTrust, key));
      return signed;
    });
    assertCurrent();
    assert(signed && result === signed && Buffer.byteLength(result) <= postsRelayReplyLimit,
      "protected_posts_relay_reply_issuer_changed");
    return result;
  }
  return {
    async handle(raw: string, peer: Peer, signal: AbortSignal) {
      closed.signal.throwIfAborted();
      signal.throwIfAborted();
      const work = accept(raw, peer, signal);
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
