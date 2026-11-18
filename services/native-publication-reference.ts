import type { Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import { consentDigest, consentUint64 } from "../packages/protocol/publication-consent.ts";
import { capturedFee, exact, parseCommand, record, same, signature } from "./publication-command-contract.ts";
import { ownedCommand, type CommandRow } from "./publication-command-store.ts";
import { publicationOriginal } from "./publication-app-request.ts";
import { publicationGrantQueueContext } from "./publication-grant-queue-context.ts";
import { publicationSelectionSource, type PublicationAppRelease } from "./publication-app-selection.ts";
import { publicationResponseBytes } from "./publication-app-documents.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";
import {
  PublicationOperatorTransport, type PublicationOperatorReferenceExchange,
} from "./publication-app-transport.ts";

export const publicationHostOrigin = "https://publication.internal";
export const publicationHostPath = "/publication/v1/host-reference";
export const publicationLookupPath = "/_operator/native-publication/reference";
// Optional on the private reverse lookup for the native publisher's live proof.
export const publicationAcceptSessionHeader = "x-pirate-publication-accept-session-sha256";
const paths = ["/publication/v1/fence", "/publication/v1/accept", "/publication/v1/reconcile"] as const;
export type PublicationNativePath = typeof paths[number];
export interface PublicationNativeReference {
  schema: "pirate.native-publication-reference/1";
  path: PublicationNativePath;
  commandId: Hex;
  nonce: Hex;
  sourceSha256: Hex;
  bodySha256: Hex;
}
export const PUBLICATION_NATIVE_REFERENCE_LIMIT = 2048;
export const PUBLICATION_NATIVE_REPLY_LIMIT = 36 * 1024;

export function publicationNativeReference(value: unknown): PublicationNativeReference {
  const r = record(value);
  exact(r, ["schema","path","commandId","nonce","sourceSha256","bodySha256"]);
  check(r.schema === "pirate.native-publication-reference/1" && paths.some(path => path === r.path),
    "native_publication_reference_invalid");
  return {
    schema: "pirate.native-publication-reference/1", path: r.path as PublicationNativePath,
    commandId: consentDigest(r.commandId), nonce: consentDigest(r.nonce),
    sourceSha256: consentDigest(r.sourceSha256), bodySha256: consentDigest(r.bodySha256),
  };
}

export function checkedPublicationCapability(value: string) {
  check(/^[a-f0-9]{64}(?![\s\S])/.test(value), "native_publication_capability_invalid");
  return value;
}
export async function nativePublicationAuthorized(request: Request, capability: string) {
  const provided = request.headers.get("authorization") ?? "";
  if (!/^Bearer [a-f0-9]{64}(?![\s\S])/.test(provided)) return false;
  const encoder = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(provided.slice(7))));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(checkedPublicationCapability(capability))));
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i]! ^ b[i]!;
  return mismatch === 0 && !request.signal.aborted;
}

export async function readPublicationNativeReference(request: Request) {
  const length = request.headers.get("content-length");
  if (length !== null)
    check(/^(0|[1-9][0-9]*)(?![\s\S])/.test(length) && Number(length) <= PUBLICATION_NATIVE_REFERENCE_LIMIT,
      "native_publication_reference_too_large");
  check(request.headers.get("content-type") === "application/json" && request.body, "native_publication_reference_required");
  const bytes = await publicationResponseBytes(new Response(request.body), PUBLICATION_NATIVE_REFERENCE_LIMIT);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const ref = publicationNativeReference(JSON.parse(text));
  check(text === canonical(ref), "native_publication_reference_not_canonical");
  request.signal.throwIfAborted();
  return ref;
}

/** Keep the workerd outbox's real transport class and installation checks.
 * Its wire request carries only the retained command identity and digests. */
type NativePublicationReleaseCheck = (release: PublicationAppRelease) => void;

export function nativePublicationOperatorTransport(
  binding: Pick<Fetcher,"fetch">,
  capability: string,
  assertRelease?: NativePublicationReleaseCheck,
) {
  const access = checkedPublicationCapability(capability);
  const exchange: PublicationOperatorReferenceExchange = async (path, row, release, body, signal) => {
    assertRelease?.(release);
    const reference: PublicationNativeReference = {
      schema: "pirate.native-publication-reference/1", path, commandId: row.command_id, nonce: row.nonce_hex,
      sourceSha256: digest(publicationSelectionSource(release)), bodySha256: digest(body),
    };
    const response = await binding.fetch(new Request(publicationHostOrigin + publicationHostPath, {
      method: "POST", headers: { "authorization": "Bearer " + access, "content-type": "application/json" },
      body: canonical(reference), redirect: "manual", signal,
    }));
    const bytes = await publicationResponseBytes(response, 32768);
    signal.throwIfAborted();
    assertRelease?.(release);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  };
  return new PublicationOperatorTransport({ exchange, timeoutMs: 10000 });
}

/** Install only under the existing private application route. Lookup returns
 * the minimum body used by the existing signed handler, never a journal row. */
export async function nativePublicationRetainedLookup(
  request: Request,
  ports: PublicationApplicationPorts,
  capability: string,
  assertRelease?: NativePublicationReleaseCheck,
) {
  const url = new URL(request.url), installation = ports.installation;
  if (!installation || url.origin !== installation.expected.origin || url.pathname !== publicationLookupPath ||
      url.search || request.method !== "POST" || !await nativePublicationAuthorized(request, capability))
    return new Response(null, { status: 404 });
  try {
    check(installation.db === ports.db && installation.catalog === ports.catalog, "publication_installation_required");
    await installation.check();
    const ref = await readPublicationNativeReference(request);
    const presentedSessionHash = request.headers.get(publicationAcceptSessionHeader);
    const sessionHash = presentedSessionHash === null ? null : consentDigest(presentedSessionHash);
    check(sessionHash === null || ref.path === "/publication/v1/accept",
      "native_publication_accept_session_scope_changed");
    const account = await ports.db.withSession("first-primary")
      .prepare("SELECT account_id FROM publication_v1_commands WHERE command_id=? AND community_id=?")
      .bind(ref.commandId, installation.expected.communityId).first<{ account_id: string }>();
    check(account, "publication_command_missing");
    const owner = { communityId: installation.expected.communityId, accountId: account.account_id };
    const row = await ownedCommand(ports.db, ref.commandId, owner);
    const original = publicationOriginal(row, ports.catalog);
    // The trusted current mount determines the installed archive. The
    // retained source still binds its own historical installation identity.
    check(row.nonce_hex === ref.nonce &&
      digest(original.source) === ref.sourceSha256, "native_publication_reference_changed");

    assertRelease?.(original.release);
    let body: unknown;
    let fresh: { cutoff: number; witness: CommandRow | null } | undefined;
    if (ref.path === "/publication/v1/fence") {
      check(row.action === "withdraw" && row.fence_generation !== null && row.fence_generation > 0, "publication_fence_pending");
      body = {
        schema: "pirate.publication-inhibition/1", commandId: row.command_id, accountId: row.account_id,
        requestId: row.request_id, source: original.source, learner: original.capture.learner, purpose: row.purpose,
        generation: String(row.fence_generation), requestHash: row.request_hash,
      };
    } else {
      check(row.phase === "accepted" && row.typed_json, "publication_not_accepted");
      const command = parseCommand(JSON.parse(row.typed_json));
      check(command.commandId === ref.commandId && command.message.nonce === ref.nonce &&
        same(command.source, original.source), "native_publication_reference_changed");
      if (ref.path === "/publication/v1/reconcile") body = { commandId: row.command_id };
      else {
        check(row.accepted_json && row.signature, "publication_original_missing");
        const accepted = record(JSON.parse(row.accepted_json));
        exact(accepted, ["command", "signature", "fee"]);
        check(canonical(accepted) === row.accepted_json && canonical(accepted.command) === row.typed_json &&
          signature(accepted.signature) === row.signature && same(capturedFee(accepted.fee), original.release.fee),
          "publication_original_changed");
        if (command.action === "grant") {
          installation.fence("active", original.source.releaseSelectionSha256);
          const context = await publicationGrantQueueContext(ports, row, command);
          const cutoff = Number(consentUint64(command.message.submitBefore));
          check(context.kind === "current" && Number.isSafeInteger(cutoff),
            "publication_fresh_queue_not_current");
          fresh = { cutoff, witness: context.witness };
        }
        body = accepted;
      }
    }
    check(sessionHash === null || fresh !== undefined, "native_publication_accept_session_scope_changed");
    check(digest(body) === ref.bodySha256, "native_publication_body_changed");
    // The last primary statement couples the original version and retained
    // mount. For a fresh grant it also couples the exact admitted head,
    // withdrawal witness, pending-withdrawal predicate and DB clock.
    const fence = installation.fence(fresh ? "active" : "retained", original.source.releaseSelectionSha256);
    const currentHead = fresh ? `AND EXISTS(
      SELECT 1 FROM publication_v1_heads h
      WHERE h.community_id=c.community_id AND h.account_id=c.account_id
        AND h.source_id=c.source_id AND h.purpose=c.purpose
        AND h.generation=c.fence_generation AND h.stop_command_id IS ?
        AND (h.stop_command_id IS NULL OR EXISTS(
          SELECT 1 FROM publication_v1_commands prior WHERE prior.command_id=h.stop_command_id
            AND prior.version=? AND prior.observation_hash IS ?))
        AND NOT EXISTS(SELECT 1 FROM publication_v1_commands w
          WHERE w.community_id=h.community_id AND w.account_id=h.account_id
            AND w.source_id=h.source_id AND w.purpose=h.purpose AND w.action='withdraw'
            AND (w.fence_generation IS NULL OR w.fence_ack_json IS NULL
              OR COALESCE(w.result_state,'') NOT IN ('recorded','reverted','withheld')))
      ) AND unixepoch('now') < ?` : "";
    const headValues = fresh
      ? [fresh.witness?.command_id ?? null, fresh.witness?.version ?? null,
        fresh.witness?.observation_hash ?? null, fresh.cutoff]
      : [];
    // The signed owner pins the participant's ordinary submit session by
    // digest. Only primary D1 can establish that session is still live and
    // owns this exact binding. Neither the cookie nor CSRF crosses this route.
    const liveSession = sessionHash === null ? "" : `AND EXISTS(
      SELECT 1 FROM community_sessions s
      JOIN community_accounts a ON a.account_id=s.account_id
      JOIN credential_bindings b ON b.account_id=s.account_id AND b.binding_id=s.binding_id
      WHERE s.session_hash=? AND s.community_id=c.community_id AND s.account_id=c.account_id
        AND s.community_origin=? AND s.binding_id=? AND a.author_id=? AND lower(b.subject)=?
        AND s.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
    )`;
    const sessionValues = sessionHash === null ? [] : [
      sessionHash, original.capture.origin, original.capture.bindingId,
      original.capture.authorId, original.capture.learner,
    ];
    const latest = await ports.db.withSession("first-primary")
      .prepare(`SELECT 1 AS live FROM publication_v1_commands c
        WHERE c.command_id=? AND c.community_id=? AND c.account_id=? AND c.version=?
          AND c.nonce_hex=? AND c.request_hash=? AND (${fence.sql}) ${currentHead} ${liveSession}`)
      .bind(row.command_id, row.community_id, row.account_id, row.version,
        row.nonce_hex, row.request_hash, ...fence.values, ...headValues, ...sessionValues)
      .first<{ live: number }>();
    check(latest?.live === 1, "native_publication_command_changed");
    request.signal.throwIfAborted();
    assertRelease?.(original.release);
    const json = canonical({ reference: ref, body });
    check(new TextEncoder().encode(json).length <= PUBLICATION_NATIVE_REPLY_LIMIT, "native_publication_body_too_large");
    return new Response(json, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch { return new Response(null, { status: 409 }); }
}
