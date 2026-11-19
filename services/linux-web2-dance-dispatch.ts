import type { Hex } from "viem";
import type { AccountSession } from "../packages/community/accounts.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";
import { bytes32, canonical, exact, insist, object } from "../packages/community/common.ts";
import type { DancePublicationActionInput } from "./dance-publication-actions.ts";
import { DanceV2ActionStore, danceDispatchSessionPin, type DanceV2Action, type DanceV2ReadyCommand } from "./dance-v2-action-store.ts";
import { openInstalledDanceScope, type NativeDanceTransportEnv } from "./linux-web2-dance-retained-transport.ts";
import {
  assertNativeDanceScope, nativeDanceDispatchPath, nativeDanceDispatchReadyPath,
  nativeDanceReference, nativeDanceReply, nativeDanceReplyLimit, nativeDanceResponse, readNativeDanceReference,
  type NativeDanceRetainedScope,
} from "./native-dance-retained-reference.ts";
import {
  nativePublicationAuthorized, publicationAcceptSessionHeader, publicationHostOrigin,
} from "./native-publication-reference.ts";
import { assertNativeDanceDispatchProofCurrent, type NativeDanceDispatchProof } from "./native-dance-dispatch-proof.ts";
import { publicationResponseBytes } from "./publication-app-documents.ts";
import { PublicationRequestSession, readNativeDanceDispatchSession } from "./publication-app-request.ts";

type Capabilities = { forward: string; reverse: string };
type DispatchScope = {
  db: D1Database;
  scope: NativeDanceRetainedScope;
  origin: string;
  assertCurrent(): Promise<unknown>;
};
export type RevalidateNativeDanceAction = (
  action: Readonly<DanceV2Action>,
  ready: Readonly<DanceV2ReadyCommand>,
  session: Readonly<AccountSession>,
) => Promise<{ fences: readonly DanceFence[]; expiresAtMs: number }>;

const unavailable = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

function distinctCapabilities({ forward, reverse }: Capabilities) {
  const valid = /^[0-9a-f]{64}(?![\s\S])/;
  return forward !== reverse && valid.test(forward) && valid.test(reverse);
}

async function committedDispatch(mount: DispatchScope, commandId: Hex, sessionHash: Hex) {
  const { db, scope, origin } = mount;
  const row = await db.withSession("first-primary").prepare(
    `SELECT o.*, r.source_hash,r.publisher,r.command_hash,r.encoded,r.calldata,r.resource_id,p.session_sha256
       FROM dance_v2_action_originals o
       JOIN dance_v2_ready_commands r ON r.command_id=o.command_id
       JOIN dance_v2_dispatch_sessions p ON p.command_id=o.command_id
      WHERE o.community_id=? AND o.command_id=?`,
  ).bind(scope.communityId, commandId).first<DanceV2Action & DanceV2ReadyCommand & { session_sha256: Hex }>();
  insist(row, "native_dance_dispatch_not_committed", 503);
  const { source_hash, publisher, command_hash, encoded, calldata, resource_id, session_sha256, ...action } = row;
  const ready = { command_id: action.command_id, source_hash, publisher, command_hash, encoded, calldata, resource_id };
  const store = new DanceV2ActionStore(db);
  store.same(action, store.original(scope.communityId, action.capture_id, action.kind, action.account_id,
    object(JSON.parse(action.input_json))));
  const reference = nativeDanceReference({
    schema: "pirate.native-dance-retained-reference/1", installationId: scope.installationId, releaseSha256: scope.releaseSha256,
    original: { chainId: scope.chainId, communityId: scope.communityId, verifier: scope.verifier,
      publisher, sourceHash: source_hash, kind: action.kind, commandId: action.command_id,
      commandHash: command_hash, resourceId: resource_id },
  });
  assertNativeDanceScope(reference, scope);
  const session = await readNativeDanceDispatchSession(db, { communityId: scope.communityId, origin }, action.account_id, sessionHash);
  insist(danceDispatchSessionPin(session) === session_sha256, "native_dance_dispatch_session_changed", 403);
  return { action, ready, session, reference };
}

/** Only a committed primary action and its same accepting session can cross the
 * effect wire. The publisher reply stays private; ordinary recovery checks it. */
export async function dispatchCommittedDanceAction(
  commandId: Hex, accepted: Readonly<AccountSession>, mount: DispatchScope,
  { forward, reverse, host }: Capabilities & { host: Pick<Fetcher, "fetch"> }, caller?: AbortSignal,
) {
  insist(distinctCapabilities({ forward, reverse }), "native_dance_dispatch_capability_invalid", 503);
  const signal = caller ? AbortSignal.any([caller, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  await mount.assertCurrent();
  const committed = await committedDispatch(mount, commandId, bytes32(accepted.session_hash));
  insist(danceDispatchSessionPin(committed.session) === danceDispatchSessionPin(accepted),
    "native_dance_dispatch_session_changed", 403);
  await mount.assertCurrent();
  signal.throwIfAborted();

  const { reference } = committed;
  const response = await host.fetch(new Request(publicationHostOrigin + nativeDanceDispatchPath, {
    method: "POST", body: canonical(reference), redirect: "manual", signal,
    headers: { authorization: "Bearer " + forward, "content-type": "application/json",
      [publicationAcceptSessionHeader]: committed.session.session_hash },
  }));
  insist(response.ok && response.headers.get("content-type") === "application/json", "native_dance_dispatch_unavailable", 503);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(await publicationResponseBytes(response, nativeDanceReplyLimit));
  const result = object(nativeDanceReply(raw, reference));
  exact(result, ["nonce", "hash"]);
  insist(typeof result.nonce === "number" && Number.isSafeInteger(result.nonce) && result.nonce >= 0,
    "native_dance_dispatch_reply_changed", 503);
  bytes32(result.hash);
  await mount.assertCurrent();
  signal.throwIfAborted();
}

/** Separate from retained-original lookup. Possession of the read path, an
 * account identifier, or a different live session cannot authorize a send. */
export async function nativeDanceDispatchReadyResponse(
  request: Request, capabilities: Capabilities, open: () => Promise<DispatchScope>, revalidate: RevalidateNativeDanceAction,
) {
  const url = new URL(request.url);
  if (url.pathname !== nativeDanceDispatchReadyPath || url.search || url.hash || request.method !== "POST" ||
      request.headers.has("X-Pirate-Native-Request") || request.headers.has("cookie") || request.headers.has("x-csrf-token") ||
      !distinctCapabilities(capabilities) || !await nativePublicationAuthorized(request, capabilities.reverse))
    return unavailable(404);
  try {
    const sessionHash = bytes32(request.headers.get(publicationAcceptSessionHeader));
    const reference = await readNativeDanceReference(request);
    const mount = await open();
    insist(url.origin === mount.origin, "native_dance_dispatch_origin_changed", 403);
    assertNativeDanceScope(reference, mount.scope);
    await mount.assertCurrent();
    const committed = await committedDispatch(mount, reference.original.commandId, sessionHash);
    insist(canonical(committed.reference) === canonical(reference), "native_dance_dispatch_reference_changed", 503);
    const authority = await revalidate(committed.action, committed.ready, committed.session);
    await mount.assertCurrent();
    const store = new DanceV2ActionStore(mount.db);
    const expiresAtMs = Math.min(committed.session.expires_at, authority.expiresAtMs);
    const proof: NativeDanceDispatchProof = { calldata: committed.ready.calldata, expiresAtMs };
    assertNativeDanceDispatchProofCurrent(expiresAtMs);
    request.signal.throwIfAborted();
    // DanceV2ActionStore.assert runs a single atomic primary-D1 batch. No
    // session, mount or row read may follow this final authority operation.
    await store.assert([
      ...authority.fences,
      store.fence(committed.action),
      store.readyFence(committed.ready),
      store.dispatchSessionFence(committed.action, mount.origin, committed.session),
      { sql: `${DANCE_DB_NOW}<?`, values: [expiresAtMs] },
    ]);
    request.signal.throwIfAborted();
    assertNativeDanceDispatchProofCurrent(expiresAtMs);
    return nativeDanceResponse(reference, proof);
  } catch {
    return unavailable(503);
  }
}

export function installedNativeDanceDispatch(env: NativeDanceTransportEnv) {
  const host = env.PUBLICATION_OPERATOR_HOST, forward = env.PUBLICATION_OPERATOR_HOST_AUTH,
    reverse = env.PUBLICATION_RETAINED_LOOKUP_AUTH;
  if (!env.WEB2_DANCE_RETAINED_SCOPE_JSON || !host || !forward || !reverse || !distinctCapabilities({ forward, reverse }))
    return undefined;
  return async (input: DancePublicationActionInput, commandId: Hex) => {
    const { db, installation } = input.selection.publication;
    insist(installation && db === env.DB, "native_dance_dispatch_installation_changed", 503);
    const session = await PublicationRequestSession.open(input.request, db, input.context, installation);
    const selected = await openInstalledDanceScope(env);
    const mount = { ...selected, async assertCurrent() {
      await selected.assertCurrent();
      await session.check();
      insist(env.PUBLICATION_OPERATOR_HOST === host && env.PUBLICATION_OPERATOR_HOST_AUTH === forward &&
        env.PUBLICATION_RETAINED_LOOKUP_AUTH === reverse, "native_dance_dispatch_capability_changed", 503);
    } };
    await dispatchCommittedDanceAction(commandId, session.original, mount, { host, forward, reverse }, input.request.signal);
  };
}

export function installedNativeDanceDispatchReadyFetch(
  request: Request, env: NativeDanceTransportEnv, revalidate: RevalidateNativeDanceAction,
) {
  const forward = env.PUBLICATION_OPERATOR_HOST_AUTH, reverse = env.PUBLICATION_RETAINED_LOOKUP_AUTH;
  if (!forward || !reverse) return unavailable(404);
  return nativeDanceDispatchReadyResponse(request, { forward, reverse }, async () => {
    const mount = await openInstalledDanceScope(env);
    return { ...mount, async assertCurrent() {
      await mount.assertCurrent();
      insist(env.PUBLICATION_OPERATOR_HOST_AUTH === forward && env.PUBLICATION_RETAINED_LOOKUP_AUTH === reverse,
        "native_dance_dispatch_capability_changed", 503);
    } };
  }, revalidate);
}
