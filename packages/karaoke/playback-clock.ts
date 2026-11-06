// Independently adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-playback-clock.ts; see docs/karaoke-learner-handoff.md.
export interface KaraokeClockObservation {
  captureMs: number;
  songMs: number;
}

export interface KaraokeMappedSongRange {
  songStartMs: number;
  songEndMs: number;
}

/** Maps sample times through clock observations retained before delivery. */
export class KaraokePlaybackClock {
  private observations: KaraokeClockObservation[] = [];

  private readonly historyMs: number;
  private readonly extrapolationMs: number;

  // Parameter properties expanded for Node's strip-only TypeScript; behavior unchanged.
  constructor(historyMs = 30_000, extrapolationMs = 150) {
    this.historyMs = historyMs;
    this.extrapolationMs = extrapolationMs;
  }

  reset(observation?: KaraokeClockObservation): void {
    this.observations = [];
    if (observation) this.observe(observation);
  }

  observe(observation: KaraokeClockObservation): void {
    const { captureMs, songMs } = observation;
    if (!Number.isFinite(captureMs) || !Number.isFinite(songMs) || captureMs < 0 || songMs < 0) return;
    const last = this.observations.at(-1);
    // A seek or a replacement context needs an explicit new capture epoch.
    if (last && (captureMs <= last.captureMs || songMs < last.songMs)) return;
    this.observations.push({ captureMs, songMs });
    while (this.observations.length > 2 && this.observations[1]!.captureMs < captureMs - this.historyMs) {
      this.observations.shift();
    }
  }

  mapRange(captureStartMs: number, captureEndMs: number): KaraokeMappedSongRange | null {
    if (!Number.isFinite(captureStartMs) || !Number.isFinite(captureEndMs) || captureStartMs > captureEndMs) return null;
    const songStartMs = this.mapTime(captureStartMs);
    const songEndMs = this.mapTime(captureEndMs);
    if (songStartMs === null || songEndMs === null || songEndMs < songStartMs) return null;
    return { songStartMs, songEndMs };
  }

  private mapTime(captureMs: number): number | null {
    const first = this.observations[0];
    const last = this.observations.at(-1);
    if (!first || !last || captureMs < first.captureMs) return null;
    if (captureMs === last.captureMs) return last.songMs;
    if (captureMs > last.captureMs + this.extrapolationMs) return null;
    let left = first;
    for (const right of this.observations.slice(1)) {
      if (captureMs <= right.captureMs) return this.interpolate(left, right, captureMs);
      left = right;
    }
    const previous = this.observations.at(-2);
    // One anchor cannot establish the rate of either clock.
    return previous ? this.interpolate(previous, last, captureMs) : null;
  }

  private interpolate(left: KaraokeClockObservation, right: KaraokeClockObservation, captureMs: number): number {
    const fraction = (captureMs - left.captureMs) / (right.captureMs - left.captureMs);
    return Math.max(0, left.songMs + fraction * (right.songMs - left.songMs));
  }
}
