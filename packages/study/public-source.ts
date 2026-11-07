import { isSectionCue } from "../alignment/elevenlabs-response.ts";
import {
  validateLyrics,
  type LyricManifest,
} from "../community/lyric-manifest.ts";
import { check, digest } from "../protocol/index.ts";
import { studyExercisesHash } from "../protocol/learning-results-v3.ts";
import type { StudyLine } from "./contracts.ts";
import { normalizeStudyLineText } from "./line-selection.ts";

export const STUDY_SOURCE_MAX_BYTES = 1024 * 1024;

/** All eligible first occurrences, retaining their full-source ordinals. */
export function studySourceLines(value: LyricManifest) {
  const source = validateLyrics(value),
    hash = digest(source);
  const seen = new Set<string>();
  const lines: { ordinal: number; line: StudyLine }[] = [];
  for (const line of source.lines) {
    const text = normalizeStudyLineText(line.text);
    if (
      !text ||
      line.text.length > 512 ||
      isSectionCue(line.text) ||
      seen.has(text)
    )
      continue;
    seen.add(text);
    lines.push({
      ordinal: line.order + 1,
      line: {
        chainId: source.chainId,
        postsContract: source.postsContract,
        communityId: source.communityId,
        postId: source.postId,
        lyricRevision: source.revision,
        lineId: line.lineId,
        lineVersion: line.lineVersion,
        text: line.text,
        language: source.language,
        manifestDigest: hash,
      },
    });
  }
  return { source, hash, lines };
}

/** Source ordinals include cue/repeated lines; selection may contain gaps. */
export function studySourceSelection(
  value: LyricManifest,
  ordinals: readonly number[],
) {
  studyExercisesHash(ordinals);
  const { source, hash, lines } = studySourceLines(value);
  const eligible = new Map(lines.map((entry) => [entry.ordinal, entry.line]));
  check(
    ordinals.every((ordinal) => eligible.has(ordinal)),
    "ineligible_study_exercise",
  );
  return {
    source,
    hash,
    selected: ordinals.map((ordinal) => eligible.get(ordinal)!),
  };
}
