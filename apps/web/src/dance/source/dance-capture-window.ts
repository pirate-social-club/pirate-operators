import type { DanceSession } from "./dance-preparation-api.ts";

export type DanceCaptureWindow = Pick<
  DanceSession,
  "body_start_ms" | "body_end_ms" | "cue"
>;
// Native sources share a clock but need not deliver their first sample together.
// A no-pose take starts with video; its microphone may join within this bound.
export const DANCE_SOURCE_START_LIMIT_MS = 250;

export function isNoPoseDanceWindow(window: DanceCaptureWindow): boolean {
  return (
    window.cue.kind === "none" &&
    window.body_start_ms === 0 &&
    window.cue.start_ms === 0 &&
    window.cue.end_ms === 0 &&
    window.cue.hold_ms === 0
  );
}

export function validDanceCaptureWindow(window: DanceCaptureWindow): boolean {
  const { body_start_ms: start, body_end_ms: end, cue } = window;
  if (
    ![start, end, cue.start_ms, cue.end_ms, cue.hold_ms].every(
      Number.isSafeInteger,
    ) ||
    start < 0 ||
    end <= start
  )
    return false;
  return (
    isNoPoseDanceWindow(window) ||
    (cue.kind !== "none" &&
      start > 0 &&
      cue.start_ms >= 0 &&
      cue.hold_ms > 0 &&
      cue.end_ms <= start &&
      cue.start_ms + cue.hold_ms <= cue.end_ms)
  );
}
