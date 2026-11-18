import { canonical, insist } from "../packages/community/common.ts";
import { nativeDigest } from "../packages/community/native-business-binding.ts";
import { maxWeb2DanceBindIntentBytes, maxWeb2DanceBindPrepareBytes, readWeb2DanceBindIntent } from "../packages/community/web2-dance-bind-intent.ts";
import { readWeb2InstalledDanceRewards } from "../packages/community/web2-dance-reward-attachment.ts";
import { web2ApplicationOriginal } from "./application-native-readback.ts";
import type { Web2CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import { reuseNativePublicationApplication, type NativePublicationApplicationEnv } from "./linux-web2-publication.ts";
import { publicationAcceptSessionHeader } from "./native-publication-reference.ts";
import { publicationResponseBytes } from "./publication-app-documents.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";
import { prepareInstalledDanceBindings } from "./web2-installed-dance-bind-prepare.ts";
import type { InstalledDanceRewardBindings } from "./web2-installed-dance-rewards.ts";

/** The owning reverse route checks its directional capability and private
 * origin before this branch reads bytes. The signed intent is still required. */
export async function nativeWeb2DanceBindPrepare(
  request: Request,
  env: NativePublicationApplicationEnv & InstalledDanceRewardBindings,
  deployment: Web2CommunityDeploymentProfile,
  publication: PublicationApplicationPorts,
  reverse: string,
) {
  insist(request.body && !request.headers.has(publicationAcceptSessionHeader) &&
    env.PUBLICATION_RETAINED_LOOKUP_AUTH === reverse, "web2_dance_bind_prepare_request_invalid", 503);
  const originalJson = env.NATIVE_APPLICATION_ORIGINAL_JSON, mount = env.PUBLICATION_NATIVE_MOUNT_JSON;
  const reward = env.WEB2_DANCE_REWARD_ATTACHMENT_JSON;
  function assertBindings() {
    request.signal.throwIfAborted();
    insist(env.NATIVE_APPLICATION_ORIGINAL_JSON === originalJson && env.PUBLICATION_NATIVE_MOUNT_JSON === mount &&
      env.WEB2_DANCE_REWARD_ATTACHMENT_JSON === reward && env.WEB2_DANCE_REWARD_ATTACHMENT_SHA256 === undefined &&
      env.PUBLICATION_RETAINED_LOOKUP_AUTH === reverse, "web2_dance_bind_prepare_bindings_changed", 503);
  }
  assertBindings();
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await publicationResponseBytes(
    new Response(request.body, { headers: request.headers }), maxWeb2DanceBindIntentBytes,
  ));
  assertBindings();
  const original = await web2ApplicationOriginal(env);
  const intent = await readWeb2DanceBindIntent(raw, original);
  const rewards = await readWeb2InstalledDanceRewards({ original, attachmentJson: reward, publicationMountJson: mount });
  insist(rewards && rewards.source.sourceHash === intent.sourceHash &&
    rewards.attachment.configurationHash === intent.configurationSha256 &&
    rewards.attachment.selectionSha256 === publication.installation?.expected.selectionSha256,
    "web2_dance_bind_prepare_rewards_changed", 503);
  async function assertOwnerCurrent() {
    assertBindings();
    await reuseNativePublicationApplication(env, deployment, publication);
    insist(nativeDigest(await web2ApplicationOriginal(env)) === nativeDigest(original),
      "web2_dance_bind_intent_original_changed", 503);
    assertBindings();
  }

  await assertOwnerCurrent();
  const result = await prepareInstalledDanceBindings({ publication, source: rewards.source, intent, assertOwnerCurrent });
  const bytes = canonical(result);
  insist(new TextEncoder().encode(bytes).byteLength <= maxWeb2DanceBindPrepareBytes, "web2_dance_bind_prepare_result_size", 503);
  await assertOwnerCurrent();
  return new Response(bytes, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
