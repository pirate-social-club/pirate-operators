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

/** Source ordinals include cue/repeated lines; selection may contain gaps. */
export function studySourceSelection(
  value: LyricManifest,
  ordinals: readonly number[],
) {
  const source = validateLyrics(value),
    hash = digest(source);
  studyExercisesHash(ordinals);
  const eligible = new Set<number>(),
    seen = new Set<string>();
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
    eligible.add(line.order + 1);
  }
  check(
    ordinals.every((x) => eligible.has(x)),
    "ineligible_study_exercise",
  );
  const selected: StudyLine[] = ordinals.map((ordinal) => {
    const line = source.lines[ordinal - 1];
    return {
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
    };
  });
  return { source, hash, selected };
}
