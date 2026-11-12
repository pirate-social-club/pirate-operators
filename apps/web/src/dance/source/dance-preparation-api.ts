import type {
  DanceCapture,
  DanceConsentPolicy,
} from "../../../../../packages/dance/contracts.ts";
/** UI projection of the ACTUAL V5 capture, not a second central session API.
 * Zero no-pose cue is the explicit V5 policy; IDs and times are never invented. */
export interface DanceSession {
  readonly capture: DanceCapture;
  readonly session_id: string;
  readonly terms_hash: string;
  readonly body_start_ms: number;
  readonly body_end_ms: number;
  readonly maximum_bytes: number;
  readonly expires_at_ms: number;
  readonly state: "consented";
  readonly cue: {
    readonly kind: "none";
    readonly start_ms: 0;
    readonly end_ms: 0;
    readonly hold_ms: 0;
  };
}
export interface DanceCaptureContext {
  readonly session: DanceSession;
  readonly reference: {
    readonly canonical_song_start_ms: number;
    readonly canonical_song_end_ms: number;
  };
}
export interface DanceObjectivesContext {
  readonly consent: DanceConsentPolicy;
}
export function danceSession(
  capture: DanceCapture,
  maximumBytes: number,
): DanceSession {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0)
    throw Error("dance_media_capability_unavailable");
  return {
    capture,
    session_id: capture.captureId,
    terms_hash: capture.termsHash,
    body_start_ms: 0,
    body_end_ms: capture.durationSamples / 48,
    maximum_bytes: maximumBytes,
    expires_at_ms: capture.expiresAtMs,
    state: "consented",
    cue: { kind: "none", start_ms: 0, end_ms: 0, hold_ms: 0 },
  };
}
