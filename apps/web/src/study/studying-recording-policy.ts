// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-recording-policy.ts.
import type { StudyingAttemptRejection } from "./studying-route-model.ts";

/** Product floor for browser-reported elapsed capture time, not decoded audio. */
export const STUDY_MIN_RECORDING_DURATION_MS = 1_000;
export const STUDY_SHORT_RECORDING_MESSAGE =
  "Record for at least one second, then try again.";
export const STUDY_PROVIDER_REVIEW_MESSAGE =
  "We couldn't confirm the recording's outcome. Recording is paused for this lesson. Choose Study again to start over with a new lesson, or leave Study.";

/** Handle declared recovery details before the generic 400/409 reload path. */
export function studyingRecordingFailure(
  rejection: StudyingAttemptRejection,
): "too_short" | "provider_refused" | "provider_unknown" | undefined {
  const details = rejection.details;
  if (
    details === null ||
    typeof details !== "object" ||
    !("reason_code" in details) ||
    !("next_action" in details)
  )
    return undefined;
  if (
    rejection.status === 409 &&
    details.reason_code === "study_provider_outcome_unknown" &&
    details.next_action === "operator_review"
  )
    return "provider_unknown";
  if (
    rejection.status === 409 &&
    details.reason_code === "study_provider_refused" &&
    details.next_action === "record_again"
  )
    return "provider_refused";
  if (
    rejection.status === 400 &&
    details.reason_code === "study_recording_too_short" &&
    details.next_action === "record_again" &&
    "minimum_duration_ms" in details &&
    details.minimum_duration_ms === STUDY_MIN_RECORDING_DURATION_MS
  )
    return "too_short";
  return undefined;
}
