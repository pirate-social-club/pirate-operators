// Independently owned adaptation of api-next f017e8014001a31d07b9e2de891e0907ad194b50
// media-providers/elevenlabs-alignment-response.ts. No runtime source dependency.
// The character fallback adapts api-next a5c63b8db01d4359344d33c31d294a00fbeadb20
// (same files at f017e80) elevenlabs-alignment-response.ts parseProviderTimings
// and karaoke-readiness-repository.ts timedWords; see docs/song-alignment.md.
import { exact, insist, object } from "../community/common.ts";
import {
  validateLyrics,
  type LyricManifest,
} from "../community/lyric-manifest.ts";

export interface AlignedWord {
  lineId: `0x${string}`;
  lineVersion: number;
  wordIndex: number;
  text: string;
  startMs: number;
  endMs: number;
}
interface Timing {
  text: string;
  startMs: number;
  endMs: number;
  startOffset: number;
  endOffset: number;
}
const loss = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function timing(value: unknown, previousEnd: number, durationMs: number) {
  const row = object(value);
  insist(
    typeof row.text === "string" &&
      row.text.length > 0 &&
      row.text.length <= 4096 &&
      typeof row.start === "number" &&
      Number.isFinite(row.start) &&
      row.start >= 0 &&
      typeof row.end === "number" &&
      Number.isFinite(row.end) &&
      row.end >= row.start &&
      row.end * 1000 <= durationMs,
    "invalid_alignment_timing",
    503,
  );
  const start = Math.round(row.start * 1000),
    end = Math.round(row.end * 1000);
  // Preserve the central adapter's five-millisecond quantization tolerance.
  insist(start + 5 >= previousEnd, "reordered_alignment_timing", 503);
  return {
    text: row.text,
    startMs: Math.max(start, previousEnd),
    endMs: Math.max(end, previousEnd),
  };
}

export interface AlignmentResult {
  /** "character" when the provider's words did not bind to its characters. */
  mode: "word" | "character";
  words: AlignedWord[];
}

/** Provider text must reproduce the exact accepted transcript. Public timings
 * retain existing occurrence IDs; section cues never become sung words. */
export function alignmentResult(
  value: unknown,
  input: LyricManifest,
  durationMs: number,
): AlignmentResult {
  const lyrics = validateLyrics(input),
    response = object(value);
  insist(
    Number.isSafeInteger(durationMs) && durationMs > 0,
    "invalid_alignment_duration",
  );
  exact(response, ["characters", "words", "loss"]);
  insist(
    loss(response.loss) &&
      Array.isArray(response.characters) &&
      Array.isArray(response.words) &&
      response.characters.length > 0 &&
      response.characters.length <= 65536 &&
      response.words.length <= 32768,
    "invalid_alignment_response",
    503,
  );
  const characters: Timing[] = [];
  let offset = 0,
    endMs = 0;
  for (const entry of response.characters) {
    exact(object(entry), ["text", "start", "end"]);
    const t = timing(entry, endMs, durationMs);
    characters.push({
      ...t,
      startOffset: offset,
      endOffset: offset + t.text.length,
    });
    offset += t.text.length;
    endMs = t.endMs;
  }
  insist(
    characters.map((c) => c.text).join("") === lyrics.sourceText,
    "alignment_transcript_mismatch",
    503,
  );
  const lines: Array<
    LyricManifest["lines"][number] & { start: number; end: number }
  > = [];
  let sourceOffset = 0,
    lineIndex = 0;
  // Use precisely the retained manifest's CRLF/LF boundary. A standalone CR
  // remains within its existing occurrence and must never create a new ID.
  for (const [index, part] of lyrics.sourceText.split(/(\r?\n)/).entries()) {
    if (index % 2 === 0 && part.trim().length > 0) {
      const line = lyrics.lines[lineIndex++];
      insist(
        line && line.text === part,
        "alignment_line_binding_mismatch",
        503,
      );
      lines.push({
        ...line,
        start: sourceOffset,
        end: sourceOffset + part.length,
      });
    }
    sourceOffset += part.length;
  }
  insist(
    lineIndex === lyrics.lines.length,
    "alignment_line_binding_mismatch",
    503,
  );
  // Word entries with an invalid shape, timing or loss make the whole
  // response unavailable, exactly as in the centralized adapter.
  const wordEntries: Timing[] = [];
  let previousEnd = 0;
  for (const entry of response.words) {
    const row = object(entry);
    exact(row, ["text", "start", "end", "loss"]);
    insist(loss(row.loss), "invalid_alignment_loss", 503);
    const t = timing(row, previousEnd, durationMs);
    previousEnd = t.endMs;
    // The real provider includes whitespace separators and whole section
    // labels in this list. Validate their timing, then omit separators.
    if (/^\s+$/u.test(t.text)) continue;
    insist(!/\s/u.test(t.text) || isSectionCue(t.text), "invalid_alignment_word", 503);
    wordEntries.push({ ...t, startOffset: -1, endOffset: -1 });
  }
  // The centralized adapter uses word timings only when every word binds to
  // its exact character span; otherwise it keeps the character timings.
  const bound =
    wordEntries.length > 0
      ? wordsBindToCharacters(lyrics.sourceText, characters, wordEntries)
      : null;
  const mode = bound ? "word" : "character",
    spans = bound ?? charactersAsWords(characters);
  const counts = new Map<string, number>(),
    words: AlignedWord[] = [];
  for (const span of spans) {
    const line = lines.find(
      (l) => l.start <= span.startOffset && l.end >= span.endOffset,
    );
    // A word that crosses a lyric line cannot belong to one occurrence.
    insist(line, "alignment_word_line_mismatch", 503);
    if (isSectionCue(line.text)) continue;
    const wordIndex = counts.get(line.lineId) ?? 0;
    words.push({
      lineId: line.lineId,
      lineVersion: line.lineVersion,
      wordIndex,
      text: span.text,
      startMs: span.startMs,
      endMs: span.endMs,
    });
    counts.set(line.lineId, wordIndex + 1);
  }
  insist(words.length > 0, "incomplete_alignment_words", 503);
  return { mode, words };
}

/** Compatibility wrapper for callers that need only the sung words. */
export function alignmentWords(
  value: unknown,
  input: LyricManifest,
  durationMs: number,
): AlignedWord[] {
  return alignmentResult(value, input, durationMs).words;
}

/**
 * api-next a5c63b8 elevenlabs-alignment-response.ts wordsBindToCharacters:
 * words omit whitespace and must cover their characters' intervals, in order,
 * through the whole transcript. Returns the bound spans, or null.
 */
function wordsBindToCharacters(
  text: string,
  characters: readonly Timing[],
  words: readonly Timing[],
): Timing[] | null {
  const spans: Timing[] = [];
  let cursor = 0;
  for (const word of words) {
    while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor++;
    if (!text.startsWith(word.text, cursor)) return null;
    const end = cursor + word.text.length,
      covered = characters.filter(
        (c) => c.endOffset > cursor && c.startOffset < end,
      ),
      first = covered[0],
      last = covered.at(-1);
    if (
      !first ||
      !last ||
      word.startMs > first.startMs ||
      word.endMs < last.endMs
    )
      return null;
    spans.push({ ...word, startOffset: cursor, endOffset: end });
    cursor = end;
  }
  while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor++;
  return cursor === text.length ? spans : null;
}

/**
 * api-next a5c63b8 karaoke-readiness-repository.ts timedWords, character mode:
 * consecutive non-whitespace character timings form one word, and a
 * whitespace entry ends it. An entry mixing whitespace and text is refused.
 */
function charactersAsWords(characters: readonly Timing[]): Timing[] {
  const words: Timing[] = [];
  let current: Timing | null = null;
  for (const character of characters) {
    if (/^\s+$/u.test(character.text)) {
      if (current) words.push(current);
      current = null;
      continue;
    }
    insist(!/\s/u.test(character.text), "invalid_alignment_character", 503);
    current = current
      ? {
          text: current.text + character.text,
          startMs: current.startMs,
          endMs: character.endMs,
          startOffset: current.startOffset,
          endOffset: character.endOffset,
        }
      : { ...character };
  }
  if (current) words.push(current);
  return words;
}

/**
 * api-next a5c63b8 packages/domain/src/study/lyric-line-identity.ts
 * isStandaloneLyricMetadataLine: a single bracketed annotation or a
 * parenthesized instrumental direction is a section cue, never sung words.
 */
const INSTRUMENTAL_DIRECTION =
  /^\(\s*instrumental(?:\s+solo|\s+breakdown(?:\s+with\s+vocal\s+chops)?)?\s*\)$/iu;
export function isSectionCue(value: string) {
  const trimmed = value.trim(),
    interior = trimmed.slice(1, -1);
  return (
    (trimmed.startsWith("[") &&
      trimmed.endsWith("]") &&
      !interior.includes("[") &&
      !interior.includes("]") &&
      !interior.includes("\r") &&
      !interior.includes("\n")) ||
    INSTRUMENTAL_DIRECTION.test(trimmed)
  );
}
