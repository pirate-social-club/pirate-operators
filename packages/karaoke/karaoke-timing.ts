// Independently adopted from pirate-web-solid 667a6f22 src/features/karaoke/karaoke-timing.ts; see docs/karaoke-learner-handoff.md.
import type { KaraokeStageLine } from "./lyric-transform.ts";

export const KARAOKE_LINE_HOLD_MS = 1600;

export function getLyricDurationMs(
  lines: readonly KaraokeStageLine[],
  audioDurationMs?: number,
): number {
  if (audioDurationMs !== undefined && Number.isFinite(audioDurationMs) && audioDurationMs > 0) {
    return Math.max(1, Math.round(audioDurationMs));
  }

  const lyricEndMs = lines.reduce((maxEndMs, line) => Math.max(maxEndMs, line.endMs), 0);
  return Math.max(1, lyricEndMs + KARAOKE_LINE_HOLD_MS);
}

export function clampKaraokeLinesToDuration(
  lines: readonly KaraokeStageLine[],
  audioDurationMs?: number,
): KaraokeStageLine[] {
  if (audioDurationMs === undefined || !Number.isFinite(audioDurationMs) || audioDurationMs <= 0) {
    return [...lines];
  }

  return lines.flatMap((line) => {
    const endMs = Math.min(line.endMs, audioDurationMs);
    if (endMs <= line.startMs) return [];
    return [{
      ...line,
      endMs,
      tokens: line.tokens
        .filter((token) => token.startMs < audioDurationMs)
        .map((token) => ({
          ...token,
          endMs: Math.max(token.startMs, Math.min(token.endMs, audioDurationMs)),
        })),
    }];
  });
}

export function displayLines(lines: readonly KaraokeStageLine[], currentTimeMs: number) {
  const activeIndex = lines.findIndex((line) => currentTimeMs >= line.startMs && currentTimeMs <= line.endMs);
  const nextIndex = activeIndex >= 0
    ? lines.findIndex((line, index) => index > activeIndex && line.startMs > lines[activeIndex]!.endMs)
    : lines.findIndex((line) => currentTimeMs < line.startMs);
  const last = lines.at(-1);
  const heldIndex = activeIndex < 0 && nextIndex < 0 && last && currentTimeMs > last.endMs ? lines.length - 1 : -1;
  const visibleIndex = activeIndex >= 0 ? activeIndex : heldIndex;
  return {
    activeLine: visibleIndex >= 0 ? lines[visibleIndex] : null,
    cueLine: visibleIndex === -1 && nextIndex >= 0 ? lines[nextIndex] : null,
    nextLine: visibleIndex >= 0 && nextIndex >= 0 ? lines[nextIndex] : null,
  };
}
