import type { DanceReview } from "../../../../packages/dance/contracts.ts";
export function danceStatus(review: DanceReview): {
  title: string;
  detail: string;
} {
  if (review.state === "withdrawn")
    return {
      title: "Withdrawn",
      detail: "This submission cannot be reviewed.",
    };
  if (review.state === "expired")
    return {
      title: "Review expired",
      detail: "The seven-day review window has ended.",
    };
  if (!review.verdict)
    return {
      title: "Awaiting review",
      detail:
        "A community owner or moderator will review your private performance.",
    };
  if (review.verdict.verdict === "not_passed")
    return { title: "Not passed", detail: "This performance did not qualify." };
  switch (review.verdict.rewardReason) {
    case "candidate_held":
      return {
        title: "Passed",
        detail:
          "Approved performance. Reward entry is awaiting the community’s categorical source admission. No payout is available.",
      };
    case "outside_window":
      return {
        title: "Passed",
        detail:
          "Approved after or before the offer window. This performance has no eligible reward.",
      };
    case "offer_closed":
      return {
        title: "Passed",
        detail:
          "The selected offer has closed. This performance has no eligible reward.",
      };
    case "source_not_admitted":
      return {
        title: "Passed",
        detail:
          "Dance is not admitted to the selected reward offer. This performance has no eligible reward.",
      };
    default:
      return {
        title: "Passed",
        detail: "Approved private performance. No reward offer was selected.",
      };
  }
}
export function danceError(error: unknown): string {
  if (error instanceof Error && error.message === "dance_response_unknown")
    return "The response was interrupted. Retry the same action to recover its result.";
  if (error instanceof Error && error.message === "dance_account_changed")
    return "Your account changed. Reopen Dance from your current account.";
  if (
    error instanceof Error &&
    /forbidden|self_review|unavailable/.test(error.message)
  )
    return "This action is unavailable with your current account or review permission.";
  if (error instanceof Error && /conflict|changed/.test(error.message))
    return "This submission changed. Refresh its current result before continuing.";
  return "Dance could not complete this action. Retry or refresh the current result.";
}
