export const dancePublicationStatusVersion = "pirate.dance-action-status/1";

export type DancePublicationState =
  | "awaiting_chain_clock"
  | "awaiting_publisher"
  | "retained_unsent"
  | "attempt_unknown"
  | "confirmed"
  | "reverted";

export interface DancePublicationStatus {
  version: typeof dancePublicationStatusVersion;
  requestId: string;
  actionId: `0x${string}`;
  state: DancePublicationState;
}

// Older clients persisted this observation alongside the immutable request.
export type StoredDancePublicationStatus = DancePublicationStatus |
  (Omit<DancePublicationStatus, "state"> & { state: "held" });

export function isDancePublicationRequestId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/.test(value);
}

export function isDancePublicationStatusReply(value: unknown): boolean {
  return !!value && typeof value === "object" && "version" in value &&
    value.version === dancePublicationStatusVersion;
}

export function readStoredDancePublicationStatus(value: unknown, requestId: string): StoredDancePublicationStatus {
  if (!isDancePublicationStatusReply(value))
    throw Error("dance_publication_status_invalid");
  const { version, requestId: offered, actionId, state } = value as Record<string, unknown>;
  if (Object.keys(value as object).length !== 4 ||
      !["version", "requestId", "actionId", "state"].every(key => Object.hasOwn(value as object, key)) ||
      offered !== requestId || typeof actionId !== "string" || !/^0x[0-9a-f]{64}(?![\s\S])/.test(actionId) ||
      !(state === "awaiting_chain_clock" || state === "awaiting_publisher" || state === "held" ||
        state === "retained_unsent" || state === "attempt_unknown" || state === "confirmed" || state === "reverted"))
    throw Error("dance_publication_status_invalid");
  return {
    version: version as typeof dancePublicationStatusVersion, requestId, actionId: actionId as `0x${string}`, state,
  };
}

export function readDancePublicationStatus(value: unknown, requestId: string): DancePublicationStatus {
  const status = readStoredDancePublicationStatus(value, requestId);
  if (status.state === "held" || !isDancePublicationRequestId(requestId))
    throw Error("dance_publication_status_invalid");
  return status;
}

export function dancePublicationTerminal(state: DancePublicationState) {
  return state === "confirmed" || state === "reverted";
}

export function dancePublicationRetryable(state: DancePublicationState) {
  return state === "awaiting_chain_clock" || state === "awaiting_publisher";
}
