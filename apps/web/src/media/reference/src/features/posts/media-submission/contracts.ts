export class SongSubmissionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SongSubmissionContractError";
  }
}

export const PUBLIC_SONG_AUDIO_MAX_BYTES = 64 * 1024 * 1024;
export const PUBLIC_SONG_LYRICS_MAX_CHARACTERS = 200_000;
export const PUBLIC_SONG_LYRICS_MAX_BYTES = 800_000;

export function publicSongAudioIssue(
  file: Pick<File, "name" | "size" | "type">,
): string | null {
  if (file.type !== "audio/mpeg" || !file.name.toLowerCase().endsWith(".mp3")) {
    return "Public-song v1 currently accepts MP3 only.";
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return "Audio must have a positive safe byte size.";
  }
  if (file.size > PUBLIC_SONG_AUDIO_MAX_BYTES) {
    return "Song audio must be 64 MiB or smaller.";
  }
  return null;
}

export function percentTextToBasisPoints(value: string): number {
  const normalized = value.trim();
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/u.exec(normalized);
  if (!match)
    throw new SongSubmissionContractError(
      "Revenue share must be a percentage with at most two decimal places",
    );
  const whole = Number.parseInt(match[1]!, 10);
  const fraction = Number.parseInt((match[2] ?? "").padEnd(2, "0") || "0", 10);
  const basisPoints = whole * 100 + fraction;
  if (basisPoints > 10_000)
    throw new SongSubmissionContractError("Revenue share cannot exceed 100%");
  return basisPoints;
}

export function basisPointsToPercentText(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new SongSubmissionContractError(
      "Revenue share basis points are out of range",
    );
  }
  const whole = Math.floor(value / 100);
  const fraction = String(value % 100)
    .padStart(2, "0")
    .replace(/0+$/u, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}
