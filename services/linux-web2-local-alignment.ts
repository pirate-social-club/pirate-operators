import { exact, insist, object } from "../packages/community/common.ts";

/** The local archived provider response remains byte-pinned. Its character
 * replay can combine contiguous CR and LF timings into one LF interval, only
 * when that yields the exact retained lyric manifest. */
export function localAlignmentReplay(value: unknown, sourceText: string) {
  const parsed = object(value);
  insist(Array.isArray(parsed.characters) && parsed.characters.length > 0 &&
    parsed.characters.length <= 65_536 && typeof parsed.loss === "number" &&
    Number.isFinite(parsed.loss) && parsed.loss >= 0, "karaoke_alignment_archive_invalid", 409);
  const characters = parsed.characters.map(value => {
    const row = object(value);
    exact(row, ["text", "start", "end"]);
    insist(typeof row.text === "string" && row.text.length > 0 &&
      typeof row.start === "number" && Number.isFinite(row.start) && row.start >= 0 &&
      typeof row.end === "number" && Number.isFinite(row.end) && row.end >= row.start,
      "karaoke_alignment_archive_invalid", 409);
    return { text: row.text, start: row.start, end: row.end };
  });
  const transcript = (sequence: typeof characters) => sequence.map(row => row.text).join("");
  let selected = characters;
  if (transcript(characters) !== sourceText) {
    selected = [];
    for (let i = 0; i < characters.length; i++) {
      const row = characters[i]!, next = characters[i + 1];
      if (row.text === "\r" && next?.text === "\n") {
        // Keep the union of the recorded delimiter intervals. No spoken
        // character moves, and inconsistent delimiter timing is refused.
        insist(row.end === next.start, "karaoke_alignment_archive_delimiter_changed", 409);
        selected.push({ text: "\n", start: row.start, end: next.end });
        i++;
      } else selected.push(row);
    }
  }
  insist(transcript(selected) === sourceText, "karaoke_alignment_archive_transcript_changed", 409);
  // The original provider also supplied multiword groups. Private local
  // rehearsal selects original character timing through the existing parser.
  return { characters: selected, words: [], loss: parsed.loss };
}
