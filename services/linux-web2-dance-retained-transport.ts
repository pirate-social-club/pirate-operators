import { decodeAbiParameters, decodeFunctionData } from "viem";
import { megaethReadClient } from "../packages/community/chain.ts";
import { canonical, insist, object } from "../packages/community/common.ts";
import { readWeb2InstalledDanceRewards } from "../packages/community/web2-dance-reward-attachment.ts";
import { verifyWeb2DanceRetainedScope } from "../packages/community/web2-dance-retained-scope.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/v2/abi.ts";
import { danceCommand } from "../packages/dance-chain/v2/wire.ts";
import { dancePayloads } from "../packages/dance-chain/v2/wire-shapes.ts";
import { publicationSelectionHash } from "./publication-app-selection.ts";
import { publicationResponseBytes } from "./publication-app-documents.ts";
import { web2ApplicationOriginal } from "./application-native-readback.ts";
import { isWeb2Deployment, readCommunityDeploymentProfile } from "./community-deployment-profile.ts";
import { DanceV2ActionStore, type DanceV2Action, type DanceV2ReadyCommand } from "./dance-v2-action-store.ts";
import type { DanceV2OriginalLookup } from "./dance-v2-action-recovery.ts";
import { openNativePublicationApplication, reuseNativePublicationApplication, type NativePublicationApplicationEnv } from "./linux-web2-publication.ts";
import {
  checkedPublicationCapability, nativePublicationAuthorized, publicationHostOrigin,
} from "./native-publication-reference.ts";
import {
  assertNativeDanceScope, nativeDanceAttempt, nativeDanceHostPath, nativeDanceReadyPath,
  nativeDanceReference, nativeDanceReply, nativeDanceReplyLimit, nativeDanceResponse, readNativeDanceReference,
  type NativeDanceRetainedScope,
} from "./native-dance-retained-reference.ts";
import type { InstalledDanceRewardBindings } from "./web2-installed-dance-rewards.ts";

const unavailable = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
type Environment = NativePublicationApplicationEnv & InstalledDanceRewardBindings & {
  WEB2_DANCE_RETAINED_SCOPE_JSON?: string;
};
type ReadyScope = {
  db: D1Database;
  scope: NativeDanceRetainedScope;
  assertCurrent(): Promise<unknown>;
};

export function nativeDanceOriginalTransport(
  selection: NativeDanceRetainedScope,
  capability: string,
  host: Pick<Fetcher, "fetch">,
): DanceV2OriginalLookup {
  const scope = structuredClone(selection), access = checkedPublicationCapability(capability);
  return Object.freeze({
    async readRetainedAttempt(offered: Parameters<DanceV2OriginalLookup["readRetainedAttempt"]>[0]) {
      const ref = nativeDanceReference({ schema: "pirate.native-dance-retained-reference/1",
        installationId: scope.installationId, releaseSha256: scope.releaseSha256, original: offered });
      assertNativeDanceScope(ref, scope);
      const signal = AbortSignal.timeout(10000);
      const response = await host.fetch(new Request(publicationHostOrigin + nativeDanceHostPath, {
        method: "POST", body: canonical(ref), redirect: "manual", signal,
        headers: { authorization: "Bearer " + access, "content-type": "application/json" },
      }));
      insist(response.ok && response.headers.get("content-type") === "application/json", "native_dance_original_unavailable", 503);
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(await publicationResponseBytes(response, nativeDanceReplyLimit));
      signal.throwIfAborted();
      return nativeDanceAttempt(nativeDanceReply(raw, ref));
    },
  });
}

async function openInstalledScope(env: Environment) {
  const profile = env.COMMUNITY_DEPLOYMENT_PROFILE_JSON, mountJson = env.PUBLICATION_NATIVE_MOUNT_JSON,
    rewardJson = env.WEB2_DANCE_REWARD_ATTACHMENT_JSON, scopeJson = env.WEB2_DANCE_RETAINED_SCOPE_JSON,
    db = env.DB, originalJson = env.NATIVE_APPLICATION_ORIGINAL_JSON,
    deployment = readCommunityDeploymentProfile(profile ?? "");
  insist(isWeb2Deployment(deployment) && rewardJson && scopeJson && env.WEB2_DANCE_REWARD_ATTACHMENT_SHA256 === undefined,
    "native_dance_scope_unavailable", 503);
  const original = await web2ApplicationOriginal(env);
  const rewards = await readWeb2InstalledDanceRewards({ original, attachmentJson: rewardJson, publicationMountJson: mountJson });
  insist(rewards, "native_dance_scope_unavailable", 503);
  const { publication } = await openNativePublicationApplication(env, deployment, megaethReadClient(undefined, deployment.rpcUrl));
  const installation = publication.installation, release = publication.catalog.fresh();
  insist(installation && release.configuration.schema === "pirate.community-config/4", "native_dance_scope_unavailable", 503);
  const releaseSha256 = publicationSelectionHash(release);
  await verifyWeb2DanceRetainedScope({raw: scopeJson, original, rewards, configuration: release.configuration, releaseSelectionHash: releaseSha256});
  insist(releaseSha256 === publication.catalog.active && release.configuration.publisher === release.operator,
    "native_dance_scope_unavailable", 503);
  const scope: NativeDanceRetainedScope = {
    chainId: 6343, communityId: installation.expected.communityId, installationId: rewards.attachment.directoryInstallationId,
    releaseSha256, publisher: release.operator, verifier: rewards.source.domain.verifier, sourceHash: rewards.source.sourceHash,
  };
  const bindings = () => insist(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON === profile &&
    env.PUBLICATION_NATIVE_MOUNT_JSON === mountJson && env.WEB2_DANCE_REWARD_ATTACHMENT_JSON === rewardJson &&
    env.WEB2_DANCE_RETAINED_SCOPE_JSON === scopeJson &&
    env.WEB2_DANCE_REWARD_ATTACHMENT_SHA256 === undefined && env.DB === db &&
    env.NATIVE_APPLICATION_ORIGINAL_JSON === originalJson, "native_dance_scope_changed", 503);
  const assertCurrent = async () => {
    bindings();
    await reuseNativePublicationApplication(env, deployment, publication);
    bindings();
  };
  await assertCurrent();
  return { db, scope, assertCurrent, origin: deployment.origin };
}

/** Lazy, server-owned fallback for the ordinary installed Fetch/Queue reader.
 * It uses the native signed mount and the same directional publication host. */
export function installedNativeDanceOriginals(env: Environment): DanceV2OriginalLookup | undefined {
  const host = env.PUBLICATION_OPERATOR_HOST, forward = env.PUBLICATION_OPERATOR_HOST_AUTH,
    reverse = env.PUBLICATION_RETAINED_LOOKUP_AUTH;
  if (!host || !forward || !reverse || forward === reverse) return undefined;
  return Object.freeze({
    async readRetainedAttempt(original: Parameters<DanceV2OriginalLookup["readRetainedAttempt"]>[0]) {
      const owned = structuredClone(original);
      const mount = await openInstalledScope(env);
      const checkPorts = () => insist(env.PUBLICATION_OPERATOR_HOST === host &&
        env.PUBLICATION_OPERATOR_HOST_AUTH === forward && env.PUBLICATION_RETAINED_LOOKUP_AUTH === reverse,
        "native_dance_scope_changed", 503);
      checkPorts();
      const result = await nativeDanceOriginalTransport(mount.scope, forward, host).readRetainedAttempt(owned);
      await mount.assertCurrent();
      checkPorts();
      return result;
    },
  });
}

/** Private reverse path. It signs and writes nothing. The request describes a
 * lookup, while the actual primary application row chooses the calldata. */
export async function nativeDanceReadyResponse(
  request: Request, capability: string, open: () => Promise<ReadyScope>,
) {
  const url = new URL(request.url);
  if (url.pathname !== nativeDanceReadyPath || url.search || url.hash || request.method !== "POST" ||
      request.headers.has("X-Pirate-Native-Request") || !await nativePublicationAuthorized(request, capability))
    return unavailable(404);
  try {
    const ref = await readNativeDanceReference(request), { original } = ref;
    const mounted = await open();
    assertNativeDanceScope(ref, mounted.scope);
    await mounted.assertCurrent();
    const row = await mounted.db.withSession("first-primary").prepare(
      `SELECT o.*, r.source_hash,r.publisher,r.command_hash,r.encoded,r.calldata,r.resource_id
         FROM dance_v2_action_originals o JOIN dance_v2_ready_commands r ON r.command_id=o.command_id
        WHERE o.command_id=? AND o.community_id=? AND o.kind=?`,
    ).bind(original.commandId, original.communityId, original.kind).first<DanceV2Action & DanceV2ReadyCommand>();
    insist(row && row.source_hash === original.sourceHash && row.publisher === original.publisher &&
      row.command_hash === original.commandHash && row.resource_id === original.resourceId, "native_dance_ready_changed", 503);
    const store = new DanceV2ActionStore(mounted.db);
    const { source_hash: _source, publisher: _publisher, command_hash: _hash, encoded: _encoded,
      calldata: _calldata, resource_id: _resource, ...action } = row;
    store.same(action, store.original(original.communityId, action.capture_id, original.kind, action.account_id, object(JSON.parse(action.input_json))));
    const decoded = decodeFunctionData({ abi: danceVerdictsAbi, data: row.calldata });
    const domain = { chainId: BigInt(original.chainId), verifier: original.verifier, communityId: original.communityId };
    let expected;
    if (decoded.functionName === "registerSubmission" && original.kind === "register") {
      const [payload] = decodeAbiParameters([dancePayloads.registerSubmission], row.encoded);
      insist(payload.submission.submissionId === original.resourceId, "native_dance_ready_changed", 503);
      expected = danceCommand(domain, decoded.functionName, original.publisher, original.commandId, payload);
    } else if (decoded.functionName === "commitVerdict" && original.kind === "verdict") {
      const [payload] = decodeAbiParameters([dancePayloads.commitVerdict], row.encoded);
      insist(payload.decision.submissionId === original.resourceId, "native_dance_ready_changed", 503);
      expected = danceCommand(domain, decoded.functionName, original.publisher, original.commandId, payload);
    }
    insist(expected && expected.data === row.calldata && expected.hash === original.commandHash &&
      expected.encoded === row.encoded, "native_dance_ready_changed", 503);
    await mounted.assertCurrent();
    request.signal.throwIfAborted();
    return nativeDanceResponse(ref, row.calldata);
  } catch {
    return unavailable(503);
  }
}

export function installedNativeDanceReadyFetch(request: Request, env: Environment) {
  const reverse = env.PUBLICATION_RETAINED_LOOKUP_AUTH, forward = env.PUBLICATION_OPERATOR_HOST_AUTH;
  if (!reverse || !forward || reverse === forward || !/^[0-9a-f]{64}(?![\s\S])/.test(reverse)) return unavailable(404);
  return nativeDanceReadyResponse(request, reverse, async () => {
    const mount = await openInstalledScope(env);
    insist(new URL(request.url).origin === mount.origin, "native_dance_scope_changed", 503);
    return { ...mount, async assertCurrent() {
      await mount.assertCurrent();
      insist(env.PUBLICATION_RETAINED_LOOKUP_AUTH === reverse && env.PUBLICATION_OPERATOR_HOST_AUTH === forward,
        "native_dance_scope_changed", 503);
    } };
  });
}
