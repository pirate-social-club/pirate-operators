import { bytes32, insist } from "../community/common.ts";
import {
  DANCE_VERSION,
  DANCE_PRIVATE_MEDIA_POLICY,
  type DanceCapture,
  type DanceMediaBinding,
  type DanceReadyMedia,
  type DanceAuthority,
  type DanceFence,
} from "./contracts.ts";

export function danceId(value: unknown): string {
  insist(
    typeof value === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(value),
    "dance_invalid_id",
  );
  return value;
}
export function danceTime(n: number) {
  insist(
    Number.isSafeInteger(n) && n >= 0 && n < 8_000_000_000_000_000,
    "dance_invalid_time",
  );
  return n;
}
export function validateFence(f: DanceFence) {
  insist(
    f &&
      typeof f.sql === "string" &&
      f.sql.trim().length > 0 &&
      f.values instanceof Array &&
      f.values.every(
        (v) =>
          v === null ||
          typeof v === "string" ||
          (typeof v === "number" && Number.isFinite(v)),
      ),
    "dance_fence_unavailable",
    503,
  );
  return f;
}
export function validateAuthority(
  a: DanceAuthority,
  actor: string,
  learner: string,
) {
  insist(
    a.actor.accountId === actor &&
      a.learner.accountId === learner &&
      a.actor.active &&
      a.learner.active,
    "dance_account_unavailable",
    403,
  );
  for (const p of [a.actor, a.learner]) {
    danceId(p.accountId);
    danceId(p.identityId);
    insist(
      Number.isSafeInteger(p.revision) && p.revision > 0,
      "dance_identity_unavailable",
      503,
    );
  }
  danceId(a.owner.accountId);
  danceId(a.owner.identityId);
  danceId(a.owner.assignmentId);
  validateFence(a.fence);
}
export function validateCapture(c: DanceCapture) {
  insist(
    c.version === DANCE_VERSION &&
      c.policy === "moderator-review-policy-v2" &&
      c.mediaPolicyVersion === DANCE_PRIVATE_MEDIA_POLICY.version,
    "dance_policy_mismatch",
  );
  [c.captureId, c.accountId, c.identityId].forEach(danceId);
  [
    c.communityId,
    c.songKey,
    c.audioSha256,
    c.rulesHash,
    c.termsHash,
    c.rubricHash,
  ].forEach(bytes32);
  insist(/^0x[a-f0-9]{40}$/.test(c.wallet), "dance_wallet_invalid");
  insist(
    Number.isSafeInteger(c.accountRevision) &&
      c.accountRevision > 0 &&
      Number.isSafeInteger(c.songRevision) &&
      c.songRevision > 0,
    "dance_revision_invalid",
  );
  insist(
    Number.isSafeInteger(c.startSample) &&
      c.startSample >= 0 &&
      Number.isSafeInteger(c.durationSamples) &&
      c.durationSamples >= 6 * 48000 &&
      c.durationSamples <= 30 * 48000,
    "dance_duration_invalid",
  );
  danceTime(c.expiresAtMs);
  if (c.reference) {
    danceId(c.reference.id);
    danceId(c.reference.segmentId);
    insist(
      Number.isSafeInteger(c.reference.revision) && c.reference.revision > 0,
      "dance_reference_invalid",
    );
  }
  if (c.offer) {
    danceId(c.offer.offerId);
    bytes32(c.offer.inputHash);
    bytes32(c.offer.sourceId);
    danceTime(c.offer.opensAtMs);
    danceTime(c.offer.cutoffAtMs);
    insist(
      c.offer.opensAtMs < c.offer.cutoffAtMs &&
        c.expiresAtMs <= c.offer.cutoffAtMs,
      "dance_offer_window_invalid",
    );
  }
}
export function mediaBinding(
  c: DanceCapture,
): Omit<DanceMediaBinding, "recordingSha256"> {
  return {
    communityId: c.communityId,
    accountId: c.accountId,
    songKey: c.songKey,
    songRevision: c.songRevision,
    audioSha256: c.audioSha256,
    mediaPolicyVersion: c.mediaPolicyVersion,
    startSample: c.startSample,
    durationSamples: c.durationSamples,
  };
}
export function validateMedia(
  c: DanceCapture,
  m: DanceReadyMedia,
  digest?: string,
) {
  const expected = mediaBinding(c);
  for (const key of Object.keys(expected) as (keyof typeof expected)[])
    insist(m[key] === expected[key], "dance_media_binding_mismatch", 409);
  insist(m.purpose === "private-review", "dance_private_media_required", 403);
  danceId(m.id);
  bytes32(m.recordingSha256);
  insist(
    !digest || digest === m.recordingSha256,
    "dance_recording_changed",
    409,
  );
  insist(
    Number.isSafeInteger(m.revision) && m.revision > 0,
    "dance_media_revision_invalid",
  );
  danceTime(m.uploadedAtMs);
  danceTime(m.expiresAtMs);
  validateFence(m.fence);
}
