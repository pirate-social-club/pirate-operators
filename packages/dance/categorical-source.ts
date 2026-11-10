import { bytes32, canonical, insist } from "../community/common.ts";
import {
  DANCE_SOURCE,
  type DanceCanonicalEvidence,
  type DanceOfferSelection,
  type DanceReview,
} from "./contracts.ts";
import { danceTime, reviewDeadline } from "./validation.ts";
import { decisionIntegrityHash } from "./intent.ts";
/** Canonical BLOCK timestamp only; convert once, no coercion/fraction/rounding. */
export function canonicalMilliseconds(seconds: string): number {
  insist(
    /^(0|[1-9][0-9]*)$/.test(seconds),
    "dance_canonical_time_invalid",
    503,
  );
  const value = BigInt(seconds) * 1000n;
  insist(
    value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER),
    "dance_canonical_time_unsafe",
    503,
  );
  return Number(value);
}
export function cutoffIsSafe(
  safeBlockTimestampSeconds: string,
  cutoffAtMs: number,
) {
  danceTime(cutoffAtMs);
  return canonicalMilliseconds(safeBlockTimestampSeconds) >= cutoffAtMs;
}
/** This validates the consumer contract after the root's actual receipt/log/code
 * verifier. It is NOT that verifier or final ABI support. Never accept HTTP data. */
export function validateCanonicalEvidence(
  r: DanceReview,
  e: DanceCanonicalEvidence,
) {
  const i = r.decision;
  insist(i, "dance_intent_missing", 503);
  insist(
    canonical(i.preimage.capture) === canonical(r.capture) &&
      canonical(i.preimage.media) === canonical(r.media) &&
      i.preimage.mediaBindingHash === r.receipt.bindingCommitment &&
      i.preimage.mediaGeneration === r.receipt.mediaRevision &&
      i.preimage.trustedSubmittedAtMs === r.receipt.trustedSubmittedAtMs &&
      i.preimage.reviewDeadlineMs === r.receipt.reviewDeadlineMs,
    "dance_canonical_preimage_mismatch",
    503,
  );
  insist(
    e.version === DANCE_SOURCE &&
      e.verification === "coordinator-validated/1" &&
      e.removed === false &&
      e.commandId === i.commandId &&
      e.submissionId === r.reviewId &&
      e.intentIntegrityHash === decisionIntegrityHash(i.preimage) &&
      e.verdict === i.preimage.verdict &&
      canonical(e.source) === canonical(r.capture.source),
    "dance_canonical_binding_mismatch",
    503,
  );
  [
    e.commandHash,
    e.submissionHash,
    e.transactionHash,
    e.blockHash,
    e.evidenceHash,
  ].forEach(bytes32);
  insist(
    /^(0|[1-9][0-9]*)$/.test(e.blockNumber) &&
      Number.isSafeInteger(e.transactionIndex) &&
      e.transactionIndex >= 0 &&
      Number.isSafeInteger(e.logIndex) &&
      e.logIndex >= 0 &&
      (e.finality === "latest" || e.finality === "safe"),
    "dance_canonical_position_invalid",
    503,
  );
  const ms = canonicalMilliseconds(e.committedAtSeconds);
  insist(
    r.capture.consent &&
      r.capture.reservedAtMs <= r.capture.consent.acceptedAtMs &&
      r.capture.consent.acceptedAtMs <= r.receipt.trustedSubmittedAtMs &&
      r.receipt.reviewDeadlineMs ===
        reviewDeadline(r.receipt.trustedSubmittedAtMs) &&
      i.preimage.intentAcceptedAtMs >= r.receipt.trustedSubmittedAtMs &&
      ms >= i.preimage.intentAcceptedAtMs &&
      ms < r.receipt.reviewDeadlineMs,
    "dance_canonical_outside_review",
    503,
  );
  return ms;
}
export interface DanceCandidate {
  accountId: string;
  wallet: string;
  offerId: string;
  evidenceHash: string;
  completedAtMs: number;
  capturedAccountCommitment?: string;
}
export function danceQualificationEntries(
  records: readonly { review: DanceReview; evidence: DanceCanonicalEvidence }[],
  offer: DanceOfferSelection & {
    songKey: string;
    sourceAdmitted: boolean;
    safeHeadTimestampSeconds: string;
  },
): DanceCandidate[] {
  insist(
    cutoffIsSafe(offer.safeHeadTimestampSeconds, offer.cutoffAtMs),
    "reward_cutoff_not_confirmed",
    409,
  );
  insist(offer.sourceAdmitted, "dance_source_admission_held", 503);
  const candidates: DanceCandidate[] = [];
  for (const { review: r, evidence: e } of records) {
    const ms = validateCanonicalEvidence(r, e),
      o = r.capture.offer;
    if (!e.canonical || e.finality !== "safe" || e.verdict !== "pass" || !o)
      continue;
    insist(
      canonical(o) ===
        canonical({
          offerId: offer.offerId,
          offerIdCommitment: offer.offerIdCommitment,
          inputHash: offer.inputHash,
          sourceHash: offer.sourceHash,
          opensAtMs: offer.opensAtMs,
          cutoffAtMs: offer.cutoffAtMs,
        }) &&
        r.capture.songKey === offer.songKey &&
        e.source.sourceHash === offer.sourceHash,
      "dance_offer_binding_mismatch",
      503,
    );
    if (ms < offer.opensAtMs || ms >= offer.cutoffAtMs) continue;
    candidates.push({
      accountId: r.capture.learner.accountId,
      wallet: r.capture.learner.wallet.toLowerCase(),
      capturedAccountCommitment: r.capture.learner.accountCommitment,
      offerId: o.offerId,
      evidenceHash: e.evidenceHash,
      completedAtMs: ms,
    });
  }
  return candidates;
}
/** All activities must be combined BEFORE this reducer. Root owns live mount. */
export function singleOfferShares(entries: readonly DanceCandidate[]) {
  const map = new Map<string, DanceCandidate>();
  for (const e of entries) {
    const key = JSON.stringify([e.accountId, e.offerId]),
      p = map.get(key);
    insist(
      !p || p.wallet.toLowerCase() === e.wallet.toLowerCase(),
      "reward_qualifier_wallet_changed",
      409,
    );
    if (
      !p ||
      e.completedAtMs < p.completedAtMs ||
      (e.completedAtMs === p.completedAtMs && e.evidenceHash < p.evidenceHash)
    )
      map.set(key, e);
  }
  return [...map.values()].sort((a, b) =>
    a.accountId.localeCompare(b.accountId),
  );
}
