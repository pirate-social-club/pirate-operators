import type { DanceReview } from "../../../../packages/dance/contracts.ts";
import { canonicalMilliseconds } from "../../../../packages/dance/categorical-source.ts";
export function danceNeedsObservation(review: DanceReview): boolean {
  if (review.localDenied || review.state === "expired") return false;
  if (review.canonical?.canonical && review.canonical.finality === "safe")
    return false;
  return (
    review.state === "awaiting_review" ||
    review.state === "decision_pending" ||
    (!!review.canonical &&
      (!review.canonical.canonical || review.canonical.finality === "latest"))
  );
}
export function danceStatus(r: DanceReview): { title: string; detail: string } {
  if (r.canonical?.canonical) {
    if (r.canonical.verdict === "not_passed")
      return {
        title: "Not passed",
        detail: "The canonical review did not pass.",
      };
    const ms = canonicalMilliseconds(r.canonical.committedAtSeconds),
      o = r.capture.offer;
    return {
      title: "Passed",
      detail: !o
        ? "Approved performance without a reward offer."
        : ms < o.opensAtMs || ms >= o.cutoffAtMs
          ? "Approved performance. Its on-chain review was outside the offer window, so there is no eligible reward."
          : r.canonical.finality === "latest"
            ? "Review recorded on chain; safe confirmation and reward-source admission are still pending."
            : "Review safely confirmed. Reward eligibility still requires the exact admitted source and offer.",
    };
  }
  if (r.localDenied)
    return {
      title: "Withdrawal pending",
      detail:
        "Private access and new dispatch are stopped. Canonical ordering determines any already broadcast review.",
    };
  if (r.decision || r.state === "decision_pending")
    return {
      title: "Decision pending",
      detail:
        "The original decision is being reconciled for canonical publication. No final verdict or reward time has been established.",
    };
  if (r.state === "expired")
    return {
      title: "Review expired",
      detail: "The seven-day review deadline has passed.",
    };
  return {
    title: "Waiting for review",
    detail: "Your private recording is waiting for an authorized reviewer.",
  };
}
export function danceError(e: unknown) {
  const code = e instanceof Error ? e.message : "";
  if (/unknown|journal/.test(code))
    return "We couldn’t confirm the response. Resume the original submission or decision before taking another action.";
  if (code === "dance_original_command_recovered")
    return "The original command was recovered. Check its current result before continuing.";
  if (/account_changed|forbidden|unavailable|revoked/.test(code))
    return "This recording is unavailable with your current access.";
  if (/admission_held/.test(code))
    return "Community Dance admission is still pending.";
  return "We couldn’t confirm the review status. Check again.";
}
