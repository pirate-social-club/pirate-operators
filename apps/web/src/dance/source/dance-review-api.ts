import type {
  DanceCapture,
  DanceReceipt,
  DanceReview,
} from "../../../../../packages/dance/contracts.ts";
import type { ReadyMedia } from "../../../../../packages/community-media/contracts.ts";
import { assertCapture, type DanceCaptureTarget } from "./ports.ts";

export type DanceResult =
  | {
      readonly kind: "local_recording";
      readonly state: "uploaded";
      readonly capture: DanceCapture;
      readonly media: ReadyMedia;
    }
  | {
      readonly kind: "review";
      readonly state: DanceReview["state"];
      readonly review: DanceReview;
    }
  | {
      readonly kind: "receipt";
      readonly state: DanceReceipt["state"];
      readonly receipt: DanceReceipt;
    };
export function danceReviewPending(result: DanceResult) {
  return (
    ["awaiting_review", "decision_pending", "withdrawal_pending"].includes(
      result.state,
    ) ||
    (result.kind === "review" &&
      !!result.review.canonical &&
      !result.review.canonical.canonical)
  );
}
export function danceReviewEditable(result: DanceResult) {
  return (
    result.kind === "local_recording" ||
    (result.kind === "review" &&
      !result.review.localDenied &&
      !result.review.canonical?.canonical &&
      ["awaiting_review", "decision_pending"].includes(result.state))
  );
}
export function assertDanceReview(
  review: DanceReview,
  scope: DanceCaptureTarget,
  capture?: DanceCapture,
) {
  assertCapture(review.capture, scope);
  const r = review.receipt,
    c = review.capture;
  if (
    review.version !== "pirate.dance/1" ||
    review.reviewId !== c.captureId ||
    (capture && capture.captureHash !== c.captureHash) ||
    r.submissionId !== review.reviewId ||
    r.accountId !== scope.accountId ||
    r.communityId !== scope.communityId ||
    !Number.isSafeInteger(r.trustedSubmittedAtMs) ||
    r.trustedSubmittedAtMs < c.reservedAtMs ||
    !Number.isSafeInteger(r.reviewDeadlineMs) ||
    r.reviewDeadlineMs !== r.trustedSubmittedAtMs + 604800000 ||
    review.media.accountId !== scope.accountId ||
    review.media.songKey !== c.songKey ||
    review.media.songRevision !== c.songRevision ||
    review.media.audioSha256 !== c.audioSha256 ||
    review.media.startSample !== c.startSample ||
    review.media.durationSamples !== c.durationSamples
  )
    throw Error("dance_result_target_mismatch");
  if (
    review.canonical &&
    (review.canonical.commandId !== review.decision?.commandId ||
      review.canonical.submissionId !== review.reviewId ||
      review.canonical.intentIntegrityHash !==
        review.decision?.localIntegrityHash ||
      review.canonical.source.sourceHash !== c.source.sourceHash)
  )
    throw Error("dance_result_projection_invalid");
  const e = review.canonical;
  if (
    e &&
    (e.version !== "pirate.dance-verdict/1" ||
      e.verification !== "coordinator-validated/1" ||
      !["pass", "not_passed"].includes(e.verdict) ||
      typeof e.canonical !== "boolean" ||
      e.removed !== false ||
      !["latest", "safe"].includes(e.finality) ||
      !/^[1-9]\d*$/.test(e.committedAtSeconds) ||
      BigInt(e.committedAtSeconds) > BigInt(Number.MAX_SAFE_INTEGER) / 1000n ||
      Object.keys(e.source).length !== Object.keys(c.source).length ||
      Object.entries(c.source).some(
        ([key, value]) => e.source[key as keyof typeof e.source] !== value,
      ))
  )
    throw Error("dance_result_projection_invalid");
}
export function danceResultPresentation(result: DanceResult): {
  title: string;
  detail: string;
} {
  if (result.kind === "local_recording")
    return {
      title: "Ready to submit",
      detail: "This recording has not been submitted for review.",
    };
  if (result.kind === "review") {
    const r = result.review,
      e = r.canonical;
    if (e?.canonical)
      return e.verdict === "pass"
        ? {
            title: "Passed",
            detail:
              e.finality === "safe"
                ? "Your dance passed review."
                : "Your review is awaiting confirmation.",
          }
        : {
            title: "Not passed",
            detail:
              e.finality === "safe"
                ? "You can return to the song to record another attempt."
                : "Your review is awaiting confirmation.",
          };
    if (r.localDenied || r.state === "withdrawal_pending")
      return {
        title: "Withdrawal pending",
        detail:
          "Your cancellation is being confirmed.",
      };
    if (e)
      return {
        title: "Review awaiting confirmation",
        detail:
          "Your review is being confirmed.",
      };
    if (r.decision || r.state === "decision_pending")
      return {
        title: "Decision pending",
        detail:
          "Your review is being confirmed.",
      };
    if (r.state === "expired")
      return {
        title: "Not reviewed",
        detail: "This attempt did not receive a review before its deadline.",
      };
    return {
      title: "Waiting for review",
      detail: "There is no review result yet.",
    };
  }
  return {
    title:
      result.state === "withdrawal_pending"
        ? "Withdrawal pending"
        : "Request acknowledged",
    detail:
      "Your cancellation is being confirmed.",
  };
}
export const danceReviewPath = (community: string, id: string) =>
  `/dance/${encodeURIComponent(community)}/reviews/${encodeURIComponent(id)}/recording`;
export const danceResultPath = (community: string, id: string) =>
  `/dance/${encodeURIComponent(community)}/reviews/${encodeURIComponent(id)}`;
