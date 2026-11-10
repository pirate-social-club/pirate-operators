import type {
  MediaPurpose,
  MediaState,
} from "../../../../packages/community-media/contracts.ts";

/** Review follows the source journey: completed public posts leave review;
 * prepared private takes still require actual Dance submission. */
export function mediaReviewVisible(
  purpose: MediaPurpose,
  state: MediaState | undefined,
  hasRecording: boolean,
  submitted: boolean,
) {
  return purpose === "private-review"
    ? state === "ready" && !submitted
    : hasRecording && state === undefined;
}
export function danceSubmitLabel(
  uncertain: boolean,
): "Submit for review" | "Resume submission" {
  return uncertain ? "Resume submission" : "Submit for review";
}
