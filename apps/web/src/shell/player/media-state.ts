/** Values are read from a real media element; unknown metadata stays unknown. */
export function mediaFacts(
  media: Pick<HTMLMediaElement, "duration" | "currentTime" | "readyState">,
) {
  return {
    duration:
      media.readyState >= 1 &&
      Number.isFinite(media.duration) &&
      media.duration > 0
        ? media.duration
        : undefined,
    position:
      Number.isFinite(media.currentTime) && media.currentTime >= 0
        ? media.currentTime
        : undefined,
  };
}
export function timeLabel(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return "--:--";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
export function seekMedia(
  media: Pick<HTMLMediaElement, "duration" | "currentTime" | "readyState">,
  ms: number,
) {
  const { duration } = mediaFacts(media);
  if (duration === undefined || !Number.isFinite(ms)) return false;
  media.currentTime = Math.max(0, Math.min(duration, ms / 1000));
  return true;
}
