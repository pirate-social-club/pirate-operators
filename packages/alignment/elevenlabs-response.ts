// Independently owned adaptation of api-next f017e8014001a31d07b9e2de891e0907ad194b50
// media-providers/elevenlabs-alignment-response.ts. No runtime source dependency.
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

/** Provider text must reproduce the exact accepted transcript. Public timings
 * retain existing occurrence IDs; section cues never become sung words. */
export function alignmentWords(
  value: unknown,
  input: LyricManifest,
  durationMs: number,
): AlignedWord[] {
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
  let cursor = 0,
    previousEnd = 0,
    characterIndex = 0;
  const counts = new Map<string, number>(),
    words: AlignedWord[] = [];
  for (const entry of response.words) {
    const row = object(entry);
    exact(row, ["text", "start", "end", "loss"]);
    insist(loss(row.loss), "invalid_alignment_loss", 503);
    const t = timing(row, previousEnd, durationMs);
    insist(!/\s/u.test(t.text), "invalid_alignment_word", 503);
    while (
      /\s/u.test(lyrics.sourceText[cursor] ?? "") &&
      cursor < lyrics.sourceText.length
    )
      cursor++;
    const end = cursor + t.text.length;
    insist(
      lyrics.sourceText.startsWith(t.text, cursor),
      "alignment_word_mismatch",
      503,
    );
    while (
      characters[characterIndex] &&
      characters[characterIndex]!.endOffset <= cursor
    )
      characterIndex++;
    const first = characters[characterIndex];
    let lastIndex = characterIndex;
    while (
      characters[lastIndex + 1] &&
      characters[lastIndex + 1]!.startOffset < end
    )
      lastIndex++;
    const last = characters[lastIndex],
      line = lines.find((l) => l.start <= cursor && l.end >= end);
    insist(
      first &&
        last &&
        line &&
        t.startMs <= first.startMs &&
        t.endMs >= last.endMs,
      "alignment_word_character_mismatch",
      503,
    );
    if (!/^\s*\[[^\]\r\n]+\]\s*$/u.test(line.text)) {
      const wordIndex = counts.get(line.lineId) ?? 0;
      words.push({
        lineId: line.lineId,
        lineVersion: line.lineVersion,
        wordIndex,
        text: t.text,
        startMs: t.startMs,
        endMs: t.endMs,
      });
      counts.set(line.lineId, wordIndex + 1);
    }
    cursor = end;
    previousEnd = t.endMs;
  }
  while (
    cursor < lyrics.sourceText.length &&
    /\s/u.test(lyrics.sourceText[cursor]!)
  )
    cursor++;
  insist(
    cursor === lyrics.sourceText.length && words.length > 0,
    "incomplete_alignment_words",
    503,
  );
  return words;
}
