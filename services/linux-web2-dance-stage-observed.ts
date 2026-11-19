import { canonical, exact, hashText, insist, object } from "../packages/community/common.ts";
import { nativeDigest } from "../packages/community/native-business-binding.ts";
import { maxWeb2DanceRetainedScopeBytes, verifyWeb2DanceRetainedScope } from "../packages/community/web2-dance-retained-scope.ts";
import { readWeb2InstalledDanceRewards } from "../packages/community/web2-dance-reward-attachment.ts";
import { web2ApplicationOriginal } from "./application-native-readback.ts";
import type { Web2CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import { reuseNativePublicationApplication, type NativePublicationApplicationEnv } from "./linux-web2-publication.ts";
import { publicationAcceptSessionHeader } from "./native-publication-reference.ts";
import { publicationResponseBytes } from "./publication-app-documents.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";
import { readObservedInstalledDanceGrants } from "./web2-installed-dance-participants.ts";
import type { InstalledDanceRewardBindings } from "./web2-installed-dance-rewards.ts";

/** The existing private reverse route verifies the directional capability.
 * Only an exact owner-signed scope admits a read of the primary D1 pair. */
export async function nativeWeb2DanceStageObserved(
  request: Request,
  env: NativePublicationApplicationEnv & InstalledDanceRewardBindings,
  deployment: Web2CommunityDeploymentProfile,
  publication: PublicationApplicationPorts,
  reverse: string,
) {
  insist(request.body && !request.headers.has(publicationAcceptSessionHeader) &&
    env.PUBLICATION_RETAINED_LOOKUP_AUTH === reverse, "web2_dance_stage_proof_request_invalid", 503);
  const originalJson = env.NATIVE_APPLICATION_ORIGINAL_JSON, mount = env.PUBLICATION_NATIVE_MOUNT_JSON;
  const reward = env.WEB2_DANCE_REWARD_ATTACHMENT_JSON;
  const db = env.DB, active = publication.catalog.active, installed = publication.installation;
  insist(installed && installed.db === db && publication.db === db && active,
    "web2_dance_stage_primary_mount_required", 503);
  function assertBindings() {
    request.signal.throwIfAborted();
    insist(env.NATIVE_APPLICATION_ORIGINAL_JSON === originalJson && env.PUBLICATION_NATIVE_MOUNT_JSON === mount &&
      env.WEB2_DANCE_REWARD_ATTACHMENT_JSON === reward && env.WEB2_DANCE_REWARD_ATTACHMENT_SHA256 === undefined &&
      env.PUBLICATION_RETAINED_LOOKUP_AUTH === reverse && env.DB === db && publication.db === db &&
      publication.installation === installed && publication.catalog.active === active, "web2_dance_stage_bindings_changed", 503);
  }
  assertBindings();
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(await publicationResponseBytes(
    new Response(request.body, { headers: request.headers }), 2 * maxWeb2DanceRetainedScopeBytes + 4096,
  ));
  assertBindings();
  const proof = object(JSON.parse(raw));
  exact(proof, ["schema", "nativeOriginalSha256", "releaseSelectionHash", "scopeSha256", "scope"]);
  const original = await web2ApplicationOriginal(env);
  const originalSha256 = nativeDigest(original);
  insist(canonical(proof) === raw && proof.schema === "pirate.web2-dance-stage-observed-request/1" &&
    proof.nativeOriginalSha256 === originalSha256 && proof.releaseSelectionHash === active &&
    typeof proof.scope === "string" && proof.scopeSha256 === hashText(proof.scope).slice(2),
    "web2_dance_stage_scope_changed", 503);
  const rewards = await readWeb2InstalledDanceRewards({ original, attachmentJson: reward, publicationMountJson: mount });
  insist(rewards && rewards.attachment.selectionSha256 === installed.expected.selectionSha256,
    "web2_dance_stage_rewards_changed", 503);
  const configuration = publication.catalog.get(active).configuration;
  const scope = await verifyWeb2DanceRetainedScope({ raw:proof.scope, original, rewards, configuration, releaseSelectionHash:active });
  async function assertOwnerCurrent() {
    assertBindings();
    await reuseNativePublicationApplication(env, deployment, publication);
    insist(nativeDigest(await web2ApplicationOriginal(env)) === originalSha256, "web2_dance_stage_original_changed", 503);
    assertBindings();
  }
  await assertOwnerCurrent();
  const observed = await readObservedInstalledDanceGrants(publication, scope.grants, assertOwnerCurrent);
  const body = canonical({
    schema:"pirate.web2-dance-stage-observed-response/1", nativeOriginalSha256:originalSha256,
    releaseSelectionHash:active, scopeSha256:proof.scopeSha256, observed,
  });
  insist(new TextEncoder().encode(body).byteLength <= 256 * 1024, "web2_dance_stage_proof_result_size", 503);
  await assertOwnerCurrent();
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
