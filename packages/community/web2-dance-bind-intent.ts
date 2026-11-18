import { canonical, exact, insist, object } from "./common.ts";
import { nativeDigest, verifyNativeRecord } from "./native-business-binding.ts";
import type { Web2NativeOriginal } from "./web2-native-business-binding.ts";
import { consentAddress, consentDigest, consentUint64 } from "../protocol/publication-consent.ts";
import type { SignedRecord } from "../../deploy/linux/installed-records.ts";
import type { InstalledDanceBindIntent } from "../../services/web2-installed-dance-bind-prepare.ts";

export const web2DancePrepareContentType = "application/vnd.pirate.installed-dance-bind-intent+json";
export const maxWeb2DanceBindIntentBytes = 4096;
export const maxWeb2DanceBindPrepareBytes = 16384;

export async function readWeb2DanceBindIntent(raw: string, original: Web2NativeOriginal) {
  insist(typeof raw === "string" && raw.length <= maxWeb2DanceBindIntentBytes &&
    new TextEncoder().encode(raw).byteLength <= maxWeb2DanceBindIntentBytes, "web2_dance_bind_intent_size", 503);
  const signed: SignedRecord<InstalledDanceBindIntent> = JSON.parse(raw);
  insist(canonical(signed) === raw, "web2_dance_bind_intent_not_canonical", 503);
  await verifyNativeRecord(signed, original.trust);
  const intent = signed.body, draft = original.record.body.draft;
  exact(object(intent), ["schema", "intentId", "installedBindingSha256", "communityId", "installationId",
    "releaseSha256", "configurationSha256", "sourceHash", "ownerEpoch", "ownerWallet", "grants"]);
  insist(original.record.body.danceRewardIntentSha256 && intent.schema === "pirate.installed-dance-bind-intent/1" &&
    intent.installedBindingSha256 === "0x" + nativeDigest(original) && intent.communityId === draft.enrollment.communityId &&
    intent.installationId === draft.enrollment.installationId && Array.isArray(intent.grants) && intent.grants.length === 2,
    "web2_dance_bind_intent_original_changed", 503);
  for (const key of ["intentId", "releaseSha256", "configurationSha256", "sourceHash"] as const) consentDigest(intent[key]);
  consentAddress(intent.ownerWallet);
  insist(consentUint64(intent.ownerEpoch) > 0n, "web2_dance_bind_intent_owner_invalid", 503);
  for (const [position, grant] of intent.grants.entries()) {
    exact(object(grant), ["purpose", "commandId", "accountId"]);
    consentDigest(grant.commandId);
    insist(grant.purpose === (position === 0 ? "dance-verdict" : "dance-review-attribution") &&
      typeof grant.accountId === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(grant.accountId),
      "web2_dance_bind_intent_grant_invalid", 503);
  }
  insist(intent.grants[0].accountId !== intent.grants[1].accountId &&
    intent.grants[0].commandId !== intent.grants[1].commandId, "web2_dance_bind_intent_grants_not_independent", 503);
  return intent;
}
