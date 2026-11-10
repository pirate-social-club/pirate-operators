import { bytes32, insist } from "../community/common.ts";
import { rewardId } from "../rewards/validation.ts";
import {
  DANCE_PRIVATE_MEDIA_POLICY,
  DANCE_VERSION,
  REVIEW_WINDOW_MS,
  type DanceAuthority,
  type DanceCapture,
  type DanceFence,
  type DancePrincipal,
  type DanceMediaBinding,
  type DanceReadyMedia,
  type DanceConsentAcceptance,
} from "./contracts.ts";
export function danceId(v: unknown): string {
  insist(
    typeof v === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(v),
    "dance_invalid_id",
  );
  return v;
}
export function danceTime(v: number): number {
  insist(Number.isSafeInteger(v) && v > 0, "dance_invalid_time");
  return v;
}
export function wallet(v: string): string {
  insist(
    /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/i.test(v),
    "dance_wallet_invalid",
  );
  return v.toLowerCase();
}
export function validateFence(f: DanceFence) {
  insist(
    f && typeof f.sql === "string" && f.sql.trim() && Array.isArray(f.values),
    "dance_fence_unavailable",
    503,
  );
  return f;
}
export function principal(p: DancePrincipal, active = true) {
  danceId(p.accountId);
  wallet(p.wallet);
  danceId(p.groupId);
  bytes32(p.authorizationId);
  bytes32(p.accountCommitment);
  insist(
    Number.isSafeInteger(p.identityEpoch) &&
      p.identityEpoch > 0 &&
      Number.isSafeInteger(p.groupEpoch) &&
      p.groupEpoch > 0,
    "dance_identity_unavailable",
    503,
  );
  insist(
    Array.isArray(p.knownAliases) &&
      p.knownAliases.length > 0 &&
      p.knownAliases.length <= 128,
    "dance_alias_context_unavailable",
    503,
  );
  p.knownAliases.forEach(danceId);
  if (active) insist(p.active, "dance_account_unavailable", 403);
}
/** Known equivalence only; never a claim of unique humans. */
export function sameKnownIdentity(a: DancePrincipal, b: DancePrincipal) {
  return (
    a.accountId === b.accountId ||
    wallet(a.wallet) === wallet(b.wallet) ||
    a.groupId === b.groupId ||
    a.knownAliases.some((id) => b.knownAliases.includes(id))
  );
}
export function validateAuthority(
  a: DanceAuthority,
  actor: string,
  learner: string,
  targetActive = true,
) {
  insist(
    a.actor.accountId === actor && a.learner.accountId === learner,
    "dance_account_changed",
    403,
  );
  principal(a.actor);
  principal(a.learner, targetActive);
  wallet(a.owner.wallet);
  danceId(a.owner.assignmentId);
  danceTime(a.owner.expiresAtMs);
  validateFence(a.fence);
}
export function sameCapturedPrincipal(a: DancePrincipal, b: DancePrincipal) {
  insist(
    a.accountId === b.accountId &&
      wallet(a.wallet) === wallet(b.wallet) &&
      a.identityEpoch === b.identityEpoch &&
      a.groupId === b.groupId &&
      a.groupEpoch === b.groupEpoch,
    "dance_capture_authorization_changed",
    403,
  );
}
export function reviewDeadline(t: number) {
  danceTime(t);
  return danceTime(t + REVIEW_WINDOW_MS);
}
export function validateConsent(
  a: DanceConsentAcceptance,
  p: { version: string; termsHash: string; publicityPolicyHash: string },
) {
  insist(
    a?.accepted === true &&
      a.version === p.version &&
      a.termsHash === p.termsHash &&
      a.publicityPolicyHash === p.publicityPolicyHash,
    "dance_consent_required",
    403,
  );
}
export function validateCapture(c: DanceCapture, requireConsent = true) {
  insist(
    c.version === DANCE_VERSION &&
      c.policy === "moderator-review-policy-v2" &&
      c.mediaPolicyVersion === DANCE_PRIVATE_MEDIA_POLICY.version,
    "dance_policy_mismatch",
  );
  danceId(c.captureId);
  principal(c.learner);
  [
    c.communityId,
    c.songKey,
    c.manifestSha256,
    c.audioSha256,
    c.rulesHash,
    c.termsHash,
    c.rubricHash,
    c.mediaPolicyHash,
  ].forEach(bytes32);
  danceTime(c.reservedAtMs);
  danceTime(c.expiresAtMs);
  bytes32(c.captureHash);
  insist(c.expiresAtMs > c.reservedAtMs, "dance_capture_expired", 410);
  if (requireConsent) insist(c.consent, "dance_consent_required", 403);
  if (c.consent) {
    insist(
      c.consent.captureId === c.captureId &&
        c.consent.captureHash === c.captureHash &&
        c.consent.accountId === c.learner.accountId &&
        c.consent.accepted === true &&
        c.consent.termsHash === c.termsHash &&
        c.consent.acceptedAtMs >= c.reservedAtMs,
      "dance_consent_binding_mismatch",
    );
    danceId(c.consent.receiptId);
    danceId(c.consent.version);
    bytes32(c.consent.publicityPolicyHash);
    danceTime(c.consent.acceptedAtMs);
  }
  insist(
    Number.isSafeInteger(c.songRevision) &&
      c.songRevision > 0 &&
      Number.isSafeInteger(c.startSample) &&
      c.startSample >= 0 &&
      Number.isSafeInteger(c.durationSamples) &&
      c.durationSamples >= 288000 &&
      c.durationSamples <= 1440000 &&
      Number.isSafeInteger(c.startSample + c.durationSamples) &&
      c.startSample + c.durationSamples <= c.songDurationSamples,
    "dance_interval_invalid",
  );
  if (c.reference) {
    danceId(c.reference.id);
    danceId(c.reference.segmentId);
    bytes32(c.reference.segmentLayoutSha256);
    insist(
      c.reference.revision > 0 && c.reference.epoch > 0,
      "dance_reference_invalid",
    );
  }
  if (c.offer) {
    rewardId(c.offer.offerId);
    bytes32(c.offer.offerIdCommitment);
    bytes32(c.offer.inputHash);
    bytes32(c.offer.sourceHash);
    danceTime(c.offer.opensAtMs);
    danceTime(c.offer.cutoffAtMs);
    insist(
      c.offer.opensAtMs < c.offer.cutoffAtMs &&
        c.offer.sourceHash === c.source.sourceHash,
      "dance_offer_binding_mismatch",
    );
  }
}
export function mediaBinding(
  c: DanceCapture,
  recordingSha256: string,
): DanceMediaBinding {
  bytes32(recordingSha256);
  return {
    communityId: c.communityId,
    accountId: c.learner.accountId,
    songKey: c.songKey,
    songRevision: c.songRevision,
    audioSha256: c.audioSha256,
    recordingSha256,
    mediaPolicyVersion: c.mediaPolicyVersion,
    startSample: c.startSample,
    durationSamples: c.durationSamples,
  };
}
export function validateMedia(b: DanceMediaBinding, m: DanceReadyMedia) {
  for (const k of Object.keys(b) as (keyof DanceMediaBinding)[])
    insist(m[k] === b[k], "dance_media_binding_mismatch", 409);
  insist(
    m.purpose === "private-review" &&
      m.version === "pirate.community-media/1" &&
      Number.isSafeInteger(m.revision) &&
      m.revision > 0 &&
      m.revision < Number.MAX_SAFE_INTEGER,
    "dance_private_media_required",
    403,
  );
  danceTime(m.readyAt);
  danceTime(m.expiresAt);
}
