interface SeekableAudio {
  readyState: number;
  duration: number;
  currentTime: number;
  addEventListener(type: "canplay", listener: () => void): void;
  removeEventListener(type: "canplay", listener: () => void): void;
}

/** Metadata alone can precede a usable seek; wait for decoded audio data. */
export function positionPlaybackWhenReady(
  audio: SeekableAudio,
  songMs: () => number,
): () => void {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    audio.removeEventListener("canplay", position);
  };
  const position = () => {
    if (cancelled) return;
    const seconds = Math.max(0, songMs() / 1000);
    audio.currentTime = Number.isFinite(audio.duration)
      ? Math.min(seconds, audio.duration)
      : seconds;
    cancel();
  };
  if (audio.readyState >= 3) position();
  else audio.addEventListener("canplay", position);
  return cancel;
}
