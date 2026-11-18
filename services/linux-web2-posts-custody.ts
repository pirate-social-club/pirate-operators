import { equalTokens } from "../packages/community/token-comparison.ts";
import type { Hex, PublicClient } from "viem";
import { bytes32, canonical, hashJson, hashText, insist, jsonBody, object } from "../packages/community/common.ts";
import { megaethReadClient } from "../packages/community/chain.ts";
import { LocalPostsEffectFence, POSTS_DB_CLOCK } from "../packages/community/local-posts-custody.ts";
import { nativeDigest } from "../packages/community/native-business-binding.ts";
import {
  nativePostsCustodyPath, nativePostsOriginal, nativePostsOriginalLimit, nativePostsReplyLimit,
  nativePostsRequest, nativePostsRequestLimit, nativePostsSelectionHash, parseNativePostsCustodySelection,
  type NativePostsAnchor, type NativePostsOriginal,
} from "../packages/community/native-posts-custody.ts";
import { preparedOperation } from "../packages/community/publication.ts";
import type { ExternalOperation } from "../packages/community/publication-store.ts";
import type { Web2NativeOriginal } from "../packages/community/web2-native-business-binding.ts";
import { web2ApplicationOriginal } from "./application-native-readback.ts";
import type { CommunityEnv } from "./community-application.ts";
import type { Web2CommunityDeploymentProfile } from "./community-deployment-profile.ts";

export interface NativePostsEnv extends CommunityEnv {
  POSTS_CUSTODY_SELECTION_JSON?: string;
  POSTS_CUSTODY_HOST_AUTH?: string;
}

type NativePostsBindings = Pick<NativePostsEnv, "DB" | "POSTS_CUSTODY_SELECTION_JSON" | "POSTS_CUSTODY_HOST_AUTH">;
function bootstrap(
  env: NativePostsBindings, deployment: Web2CommunityDeploymentProfile, original: Web2NativeOriginal,
) {
  const selection = env.POSTS_CUSTODY_SELECTION_JSON;
  const auth = env.POSTS_CUSTODY_HOST_AUTH;
  if (selection === undefined && auth === undefined) return;
  insist(selection && auth && /^[a-f0-9]{64}(?![\s\S])/.test(auth), "native_posts_mount_incomplete", 503);
  const selected = parseNativePostsCustodySelection(selection);
  const { scope } = selected;
  insist(
    selected.originalSha256 === "0x" + nativeDigest(original) &&
      selected.hostInstallationId === original.record.body.installationId &&
      deployment.origin === scope.origin && deployment.directoryProfile.chainId === scope.chainId &&
      deployment.directoryProfile.communityId === scope.communityId &&
      deployment.directoryProfile.installationId === scope.installationId &&
      original.record.body.draft.configuration.publisher === scope.publisher &&
      deployment.rpcUrl === scope.native.applicationRpcUrl,
    "native_posts_mount_changed",
    503,
  );
  return { selected, auth, fence: new LocalPostsEffectFence(env.DB, scope) };
}

const installedIdentity = `EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)
  AND EXISTS(SELECT 1 FROM native_application_original WHERE singleton=1 AND original_digest=?)`;

function identityValues(mount: NonNullable<ReturnType<typeof bootstrap>>) {
  const { selected } = mount;
  return [selected.scope.communityId, selected.scope.origin, selected.originalSha256.slice(2)];
}

function stateKeys(mount: NonNullable<ReturnType<typeof bootstrap>>) {
  return [mount.fence.key, mount.fence.scopeJson()];
}

/** Call from the trusted native initializer after the normal schema and
 * original, before the first job. The normal server only reopens this row. */
export async function initializeNativePostsCustody(
  env: NativePostsBindings, deployment: Web2CommunityDeploymentProfile, original: Web2NativeOriginal,
) {
  const mount = bootstrap(env, deployment, original);
  if (!mount) return;
  await env.DB.prepare(
    `INSERT INTO local_posts_custody(slot,scope_key,scope_json,state)
      SELECT 1,?,?,'posts' WHERE ${installedIdentity}
      AND NOT EXISTS(SELECT 1 FROM publication_jobs)
      AND NOT EXISTS(SELECT 1 FROM local_posts_effects)
      ON CONFLICT(slot) DO NOTHING`,
  ).bind(...stateKeys(mount), ...identityValues(mount)).run();
  await bindNativePostsCustody(env, deployment, original);
}

/** Used by the installed fetch, queue and scheduled entrypoints. The native
 * graph is already validated by the owner before the Worker is started. */
export async function bindNativePostsCustody(
  env: NativePostsBindings, deployment: Web2CommunityDeploymentProfile, original: Web2NativeOriginal,
) {
  const mount = bootstrap(env, deployment, original);
  if (!mount) return;
  const exists = await env.DB.withSession("first-primary").prepare(
    `SELECT 1 AS found FROM local_posts_custody WHERE slot=1 AND scope_key=? AND scope_json=?
      AND ${installedIdentity}`,
  ).bind(...stateKeys(mount), ...identityValues(mount)).first<{ found: number }>();
  insist(exists?.found === 1, "native_posts_mount_unavailable", 503);
  return mount.fence;
}

// An overflowing inventory refuses before returning any partial set. CASE
// bounds the aggregate even if the retained journal has oversized fields.
const snapshot = `(SELECT CASE WHEN
    (SELECT count(*) FROM (SELECT 1 FROM external_operations WHERE step='publication' LIMIT ${nativePostsOriginalLimit + 1})) <= ${nativePostsOriginalLimit}
    AND (SELECT count(*) FROM (SELECT 1 FROM local_posts_effects LIMIT ${nativePostsOriginalLimit + 1})) <= ${nativePostsOriginalLimit}
    AND NOT EXISTS(SELECT 1 FROM external_operations WHERE step='publication'
      AND max(length(CAST(request_json AS BLOB)),coalesce(length(CAST(prepared_json AS BLOB)),0),
        coalesce(length(CAST(result_json AS BLOB)),0)) > 16384)
    AND NOT EXISTS(SELECT 1 FROM external_operations WHERE step='publication'
      AND max(length(operation_id),length(job_id),length(request_hash),
        length(status),coalesce(length(provider_id),0)) > 256)
    AND NOT EXISTS(SELECT 1 FROM local_posts_effects
      WHERE max(length(operation_id),length(job_id),length(request_hash),
        length(scope_key),coalesce(length(signed_hash),0)) > 256)
  THEN json_object('original',(SELECT original_digest FROM native_application_original WHERE singleton=1),
    'identity',json((SELECT json_array(community_id,community_origin) FROM application_identity WHERE id=1)),
    'jobs',(SELECT count(*) FROM publication_jobs WHERE lease_token IS NOT NULL AND lease_until>${POSTS_DB_CLOCK}),
    'operations',json((SELECT json_group_array(json_object('operation_id',operation_id,'job_id',job_id,
      'step',step,'request_hash',request_hash,'request_json',request_json,'status',status,
      'prepared_json',prepared_json,'result_json',result_json,'provider_id',provider_id))
      FROM (SELECT * FROM external_operations WHERE step='publication' ORDER BY operation_id))),
    'effects',json((SELECT json_group_array(json_object('operation_id',operation_id,'job_id',job_id,
      'request_hash',request_hash,'scope_key',scope_key,'signed_hash',signed_hash))
      FROM (SELECT * FROM local_posts_effects ORDER BY operation_id))))
  END)`;

interface SnapshotRow {
  state: "posts" | "draining" | "held" | "reconcile";
  holder: string | null;
  snapshot_sha256: Hex | null;
  safe_block: string | null;
  safe_hash: Hex | null;
  bytes: string | null;
}

function settledOriginals(value: unknown, mount: NonNullable<ReturnType<typeof bootstrap>>) {
  const journal = object(value);
  const { scope } = mount.selected;
  insist(
    journal.original === mount.selected.originalSha256.slice(2) &&
      canonical(journal.identity) === canonical([scope.communityId, scope.origin]) &&
      journal.jobs === 0 && Array.isArray(journal.operations) && Array.isArray(journal.effects),
    "native_posts_journal_changed",
    409,
  );
  const originals: NativePostsOriginal[] = [];
  const signed = new Map<string, { job: string; requestHash: string; hash: Hex }>();
  for (const raw of journal.operations) {
    const row = raw as ExternalOperation;
    if (row.prepared_json === null) {
      insist(
        row.status === "planned" && row.provider_id === null && row.result_json === null,
        "native_posts_unsettled_original", 409,
      );
      continue;
    }
    insist(row.status === "confirmed" && row.provider_id && row.result_json, "native_posts_unsettled_original", 409);
    const { replay, payload } = preparedOperation(row);
    insist(replay.kind === "same_signed_transaction" || replay.kind === "never", "native_posts_original_changed", 409);
    const hash = replay.kind === "same_signed_transaction" ? replay.transactionHash : bytes32(payload.alreadyPublishedHash);
    const request = object(JSON.parse(row.request_json));
    const original = nativePostsOriginal({
      hash, publication: request.publication, resultSha256: hashText(row.result_json),
    });
    insist(
      row.provider_id === hash && hashJson(request) === row.request_hash &&
        original.publication.communityId === scope.communityId,
      "native_posts_original_changed", 409,
    );
    originals.push(original);
    if (replay.kind === "same_signed_transaction")
      signed.set(row.operation_id, { job: row.job_id, requestHash: row.request_hash, hash });
  }
  for (const value of journal.effects) {
    const effect = object(value);
    const original = signed.get(String(effect.operation_id));
    insist(
      original && effect.scope_key === mount.fence.key &&
        effect.job_id === original.job && effect.request_hash === original.requestHash &&
        effect.signed_hash === original.hash,
      "native_posts_unsettled_effect",
      409,
    );
    signed.delete(String(effect.operation_id));
  }
  insist(signed.size === 0, "native_posts_effect_missing", 409);
  return originals;
}

async function verifyAnchor(client: PublicClient, fence: LocalPostsEffectFence, anchor: NativePostsAnchor) {
  await fence.assertNode(client);
  const number = BigInt(anchor.number);
  const [safe, pinned] = await Promise.all([
    client.getBlock({ blockTag: "safe" }), client.getBlock({ blockNumber: number }),
  ]);
  insist(safe.number !== null && safe.number >= number && pinned.hash === anchor.hash,
    "native_posts_anchor_unavailable", 503);
}

const hidden = () => new Response(null, { status: 404 });
const reply = (value: unknown) => {
  const body = canonical(value);
  insist(new TextEncoder().encode(body).byteLength <= nativePostsReplyLimit, "native_posts_reply_limit", 409);
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
};

/** Reverse-only route on the existing app upstream, behind /_operator. The
 * holder receives evidence for Posts, never a SQL statement or raw signature. */
export async function nativePostsCustody(
  request: Request, env: NativePostsEnv, deployment: Web2CommunityDeploymentProfile,
) {
  const url = new URL(request.url), key = env.POSTS_CUSTODY_HOST_AUTH;
  const supplied = request.headers.get("authorization") ?? "";
  if (request.method !== "POST" || url.origin !== deployment.origin || url.pathname !== nativePostsCustodyPath ||
      url.search || !key || !/^[a-f0-9]{64}(?![\s\S])/.test(key) || !equalTokens(supplied, "Bearer " + key))
    return hidden();

  try {
    const original = await web2ApplicationOriginal(env);
    const mount = bootstrap(env, deployment, original);
    insist(mount && mount.auth === key, "native_posts_mount_unavailable", 503);
    const body = nativePostsRequest(await jsonBody(request, nativePostsRequestLimit));
    insist(body.selection === nativePostsSelectionHash(mount.selected), "native_posts_selection_changed", 409);
    const db = env.DB.withSession("first-primary");
    const keys = stateKeys(mount), identity = identityValues(mount);
    const replyWith = (result: unknown) => reply({ request: body, result });
    const signal = request.signal;
    signal.throwIfAborted();

    if (body.action === "pause" || body.action === "reconcile") {
      const pause = body.action === "pause";
      const statement = pause
        ? db.prepare(`UPDATE local_posts_custody SET state='draining',holder=?
          WHERE slot=1 AND scope_key=? AND scope_json=? AND state='posts' AND holder IS NULL
          AND ${installedIdentity}`).bind(body.holder, ...keys, ...identity)
        : db.prepare(`UPDATE local_posts_custody SET state='reconcile'
          WHERE slot=1 AND scope_key=? AND scope_json=? AND holder=? AND state IN ('draining','held','reconcile')
          AND ${installedIdentity}`).bind(...keys, body.holder, ...identity);
      signal.throwIfAborted();
      const updated = await statement.run();
      insist(updated.meta.changes === 1, "native_posts_custody_unavailable", 409);
      return replyWith({ state: pause ? "draining" : "reconcile" });
    }
    const row = await db.prepare(
      `SELECT state,holder,snapshot_sha256,safe_block,safe_hash,${snapshot} AS bytes
        FROM local_posts_custody WHERE slot=1 AND scope_key=? AND scope_json=? AND holder=?
        AND ${installedIdentity}`,
    ).bind(...keys, body.holder, ...identity).first<SnapshotRow>();
    insist(row?.bytes && row.holder === body.holder &&
      (body.action === "inventory" || body.action === "hold" ? row.state === "draining" : row.state === "held"),
      "native_posts_custody_unavailable", 409);
    const parsed = object(JSON.parse(row.bytes));
    if (body.action === "inventory" && typeof parsed.jobs === "number" && parsed.jobs > 0)
      return replyWith({ state: "draining" });
    const snapshotHash = hashText(row.bytes);
    if (body.action === "inventory")
      return replyWith({ state: "ready", snapshot: snapshotHash, originals: settledOriginals(parsed, mount) });

    insist("proof" in body, "native_posts_proof_required", 409);
    const { proof } = body;
    insist(proof.snapshot === snapshotHash, "native_posts_snapshot_changed", 409);
    if (body.action === "hold") settledOriginals(parsed, mount);
    else insist(row.snapshot_sha256 === proof.snapshot && row.safe_block === proof.anchor.number &&
      row.safe_hash === proof.anchor.hash, "native_posts_proof_changed", 409);
    await verifyAnchor(megaethReadClient(undefined, deployment.rpcUrl), mount.fence, proof.anchor);
    signal.throwIfAborted();
    const guard = `WHERE slot=1 AND scope_key=? AND scope_json=? AND holder=? AND state=?
      AND ${snapshot}=? AND ${installedIdentity}`;
    const trailing = [...keys, body.holder, row.state, row.bytes, ...identity];
    if (body.action === "verify") {
      const current = await db.prepare(`SELECT 1 AS found FROM local_posts_custody ${guard}
        AND snapshot_sha256=? AND safe_block=? AND safe_hash=?`)
        .bind(...trailing, proof.snapshot, proof.anchor.number, proof.anchor.hash).first<{ found: number }>();
      insist(current?.found === 1, "native_posts_snapshot_changed", 409);
      return replyWith({ state: "held" });
    }
    const change = body.action === "hold"
      ? db.prepare(`UPDATE local_posts_custody SET state='held',snapshot_sha256=?,safe_block=?,safe_hash=? ${guard}`)
        .bind(proof.snapshot, proof.anchor.number, proof.anchor.hash, ...trailing)
      : db.prepare(`UPDATE local_posts_custody SET state='posts',holder=NULL,snapshot_sha256=NULL,safe_block=NULL,safe_hash=NULL
        ${guard} AND snapshot_sha256=? AND safe_block=? AND safe_hash=?`)
        .bind(...trailing, proof.snapshot, proof.anchor.number, proof.anchor.hash);
    const updated = await change.run();
    insist(updated.meta.changes === 1, "native_posts_snapshot_changed", 409);
    return replyWith({ state: body.action === "hold" ? "held" : "posts" });
  } catch {
    return new Response(null, { status: 409, headers: { "cache-control": "no-store" } });
  }
}
