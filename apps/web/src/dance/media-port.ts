import type { JSX } from "@solidjs/web";
import type { Component } from "solid-js";
import type {
  DanceCapture,
  DanceReview,
} from "../../../../packages/dance/contracts.ts";
/** Coordinator verifies source3 repair3 exact bytes before supplying this port.
 * No source is copied/imported from a mutable peer worktree. */
export const DANCE_SURFACE_PINS = Object.freeze({
  capture: "c2e675de6efca6eb78f45da137ac9792210d09ed45efb6f6ada78ec34dd6a607",
  recordingReview:
    "80dfa4c1933253ae2fdb553c06fcf0786f82b4a838679cac8f533378b3bb8b27",
});
export interface CaptureSurfaceProps {
  preview?: JSX.Element;
  channel?: "camera" | "upload";
  status?:
    | "idle"
    | "recording"
    | "camera_denied"
    | "capability_unavailable"
    | "recording_failed"
    | "orientation_lost"
    | "guide_interrupted";
  elapsedLabel?: string;
  durationLabel?: string;
  title?: string;
  recordDisabled?: boolean;
  recordActionLabel?: string;
  allowUpload?: boolean;
  timerClass?: string;
  onClose?: () => void;
  onRecordToggle?: () => void;
  onRetake?: () => void;
  notice?: JSX.Element;
}
export interface RecordingReviewProps {
  preview: JSX.Element;
  busy: boolean;
  canSubmit: boolean;
  submitLabel: "Submit for review" | "Resume submission";
  error?: string;
  onSubmit?: () => void;
  onBack: () => void;
}
export interface DanceTake {
  mediaId: string;
  recordingSha256: string;
  previewKey: string;
}
export interface DanceMediaUiPort {
  version: "pirate.dance-surfaces/1";
  pins: typeof DANCE_SURFACE_PINS;
  CaptureSurface: Component<CaptureSurfaceProps>;
  RecordingReviewSurface: Component<RecordingReviewProps>;
  camera: () => Pick<
    CaptureSurfaceProps,
    "preview" | "status" | "elapsedLabel" | "durationLabel"
  >;
  recordPrivate: (
    capture: DanceCapture,
  ) => Promise<{ status: "ready"; take: DanceTake } | { status: "canceled" }>;
  takePreview: (take: DanceTake) => JSX.Element;
  privatePreview: (review: DanceReview) => JSX.Element;
  referencePreview: (review: DanceReview) => JSX.Element;
  clearPrivate: () => void;
}
export function assertDanceSurfaces(port: DanceMediaUiPort) {
  if (
    port.version !== "pirate.dance-surfaces/1" ||
    port.pins.capture !== DANCE_SURFACE_PINS.capture ||
    port.pins.recordingReview !== DANCE_SURFACE_PINS.recordingReview
  )
    throw Error("dance_surface_integration_held");
}
