export interface VideoDeliveryState {
  readonly playback: "pending" | "ready" | "unavailable";
  readonly thumbnail: "pending" | "ready" | "unavailable";
}

/** The existing JSON feed boundary retains only delivery status, never refs. */
export function readVideoDelivery(value: unknown): VideoDeliveryState {
  function state(input: unknown): VideoDeliveryState["playback"] {
    if (typeof input !== "object" || input === null || !("status" in input))
      return "unavailable";
    return input.status === "pending"
      ? "pending"
      : input.status === "ready"
        ? "ready"
        : "unavailable";
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("track" in value) ||
    value.track !== "video"
  ) {
    return { playback: "unavailable", thumbnail: "unavailable" };
  }
  return {
    playback: state("playback" in value ? value.playback : null),
    thumbnail: state("thumbnail" in value ? value.thumbnail : null),
  };
}

export function videoPlaybackMessage(state: VideoDeliveryState): string {
  return state.playback === "pending"
    ? "Playback is being prepared."
    : "Playback is unavailable.";
}
export function videoThumbnailMessage(state: VideoDeliveryState): string {
  return state.thumbnail === "pending"
    ? "Thumbnail is being prepared."
    : state.thumbnail === "ready"
      ? "Thumbnail is ready."
      : "Thumbnail is unavailable.";
}
