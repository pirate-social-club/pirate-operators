import { canonical, hashJson, insist } from "../community/common.ts";
import {
  DANCE_SOURCE,
  type DanceDecisionIntent,
  type DanceReview,
  type DanceVerdict,
  type ReviewerContext,
  type DecisionIntentPreimage,
} from "./contracts.ts";
import { danceTime } from "./validation.ts";
/** Sole local recovery preimage; explicitly NOT an ABI/on-chain hash. */
export const decisionEvidencePreimage = (p: DecisionIntentPreimage) =>
  canonical(p);
export const decisionIntegrityHash = (p: DecisionIntentPreimage) =>
  hashJson(JSON.parse(decisionEvidencePreimage(p)));
export function decisionIntent(
  r: DanceReview,
  commandId: string,
  verdict: DanceVerdict,
  reviewer: ReviewerContext,
  acceptedAtMs: number,
): DanceDecisionIntent {
  danceTime(acceptedAtMs);
  insist(
    verdict === "pass" || verdict === "not_passed",
    "dance_verdict_invalid",
  );
  const preimage: DecisionIntentPreimage = {
    version: DANCE_SOURCE,
    operation: "CommitVerdict",
    commandId,
    submissionId: r.reviewId,
    capture: r.capture,
    media: r.media,
    mediaId: r.receipt.mediaId,
    mediaGeneration: r.receipt.mediaRevision,
    mediaBindingHash: r.receipt.bindingCommitment,
    trustedSubmittedAtMs: r.receipt.trustedSubmittedAtMs,
    reviewDeadlineMs: r.receipt.reviewDeadlineMs,
    reviewer,
    verdict,
    intentAcceptedAtMs: acceptedAtMs,
  };
  return {
    intentId: commandId,
    commandId,
    preimage,
    localIntegrityHash: decisionIntegrityHash(preimage),
  };
}
export function submissionIntentPreimage(r: DanceReview, commandId: string) {
  insist(
    r.capture.consent &&
      r.capture.consent.acceptedAtMs <= r.receipt.trustedSubmittedAtMs,
    "dance_consent_binding_mismatch",
    503,
  );
  return {
    version: DANCE_SOURCE,
    operation: "RegisterSubmission" as const,
    commandId,
    capture: r.capture,
    media: r.media,
    mediaBindingHash: r.receipt.bindingCommitment,
    receipt: r.receipt,
    expected: r.capture.expected,
  };
}
export function assertSameIntent(
  a: DanceDecisionIntent,
  b: DanceDecisionIntent,
) {
  insist(
    a.commandId === b.commandId &&
      decisionEvidencePreimage(a.preimage) ===
        decisionEvidencePreimage(b.preimage) &&
      a.localIntegrityHash === decisionIntegrityHash(a.preimage),
    "dance_intent_conflict",
    409,
  );
}
