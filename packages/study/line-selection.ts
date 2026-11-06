// Independently adopted from api-next a5c63b8: exerciseRows ordering and
// normalizeLyricLineIdentityV1. See source fingerprints in the handoff.
import type { StudyLine } from "./contracts.ts";
import { validateStudySongLines, type StudySong } from "./lesson.ts";

export const normalizeStudyLineText = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[‘’‛′`´]/gu, "'")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

export interface StudyLinePractice {
  text: string;
  language: string;
  presentations: number;
  lastPractisedAt: number | null;
}
const practiceKey = (line: Pick<StudyLine, "text" | "language">) =>
  JSON.stringify([normalizeStudyLineText(line.text), line.language]);

export function selectStudyLessonLines(
  song: StudySong,
  lines: StudyLine[],
  history: StudyLinePractice[],
) {
  const practice = new Map<
    string,
    { presentations: number; lastPractisedAt: number | null }
  >();
  for (const row of history) {
    const key = practiceKey(row),
      previous = practice.get(key);
    practice.set(key, {
      presentations: (previous?.presentations ?? 0) + row.presentations,
      lastPractisedAt:
        previous?.lastPractisedAt === null || previous === undefined
          ? row.lastPractisedAt
          : row.lastPractisedAt === null
            ? previous.lastPractisedAt
            : Math.max(previous.lastPractisedAt, row.lastPractisedAt),
    });
  }
  const seen = new Set<string>();
  return validateStudySongLines(song, lines)
    .map((line, ordinal) => ({ line, ordinal }))
    .filter(({ line }) => {
      const text = normalizeStudyLineText(line.text);
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    })
    .map((item) => ({
      ...item,
      practice: practice.get(practiceKey(item.line)) ?? {
        presentations: 0,
        lastPractisedAt: null,
      },
    }))
    .sort((a, b) => {
      const aLast = a.practice.lastPractisedAt,
        bLast = b.practice.lastPractisedAt;
      const recency =
        aLast === bLast
          ? 0
          : aLast === null
            ? -1
            : bLast === null
              ? 1
              : aLast - bLast;
      return (
        a.practice.presentations - b.practice.presentations ||
        recency ||
        a.ordinal - b.ordinal
      );
    })
    .slice(0, 10)
    .map(({ line }) => line);
}
