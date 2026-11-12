/** Source attachPlayback port, adapted to the producer's same-origin progressive
 * MP4 rendition. HLS/provider selection is not introduced by this frontend. */
export interface PlaybackGrant {
  readonly url: string;
  readonly expiresAt: number;
  readonly renewAt: number;
}
export interface PlaybackAttachment {
  readonly video: HTMLVideoElement;
  readonly url: string;
  readonly position: number;
  readonly resume: boolean;
  readonly signal: AbortSignal;
  readonly onFailure: () => void;
}
export async function attachPlayback(
  input: PlaybackAttachment,
): Promise<() => void> {
  input.signal.throwIfAborted();
  const seek = () => {
    if (input.signal.aborted) return;
    input.video.currentTime = input.position;
    if (input.resume) void input.video.play().catch(() => {});
  };
  input.video.addEventListener("loadedmetadata", seek, {
    once: true,
    signal: input.signal,
  });
  input.video.addEventListener("error", input.onFailure, {
    once: true,
    signal: input.signal,
  });
  input.video.src = input.url;
  return () => {
    input.video.removeEventListener("loadedmetadata", seek);
    input.video.removeEventListener("error", input.onFailure);
  };
}
