import type { Hex } from "viem";
import {
  bytes32,
  exact,
  hashText,
  insist,
  integer,
  object,
  publicId,
  text,
} from "./common.ts";
import { identity, schema, type PublicationIdentity } from "./manifest-core.ts";

export interface LyricLine {
  lineId: Hex;
  lineVersion: number;
  order: number;
  text: string;
}
export interface LyricManifest extends PublicationIdentity {
  schema: "pirate.song-lyrics/1";
  revision: number;
  language: string;
  sourceText: string;
  sourceSha256: Hex;
  lines: LyricLine[];
}
const lyricTexts = (source: string) =>
  source.split(/\r?\n/).filter((line) => line.trim().length > 0);
export function validateLyrics(value: unknown): LyricManifest {
  const o = schema(value, "pirate.song-lyrics/1", [
    "chainId",
    "postsContract",
    "communityId",
    "postId",
    "revision",
    "language",
    "sourceText",
    "sourceSha256",
    "lines",
  ]);
  const sourceText = text(o.sourceText, 32768),
    expected = lyricTexts(sourceText);
  insist(
    hashText(sourceText) === bytes32(o.sourceSha256),
    "lyrics_hash_mismatch",
  );
  insist(
    Array.isArray(o.lines) &&
      o.lines.length === expected.length &&
      o.lines.length <= 2000,
    "invalid_lyric_occurrences",
  );
  const lines = o.lines.map((value, i) => {
    const l = object(value);
    exact(l, ["lineId", "lineVersion", "order", "text"]);
    insist(
      l.order === i && l.text === expected[i],
      "lyric_occurrence_mismatch",
    );
    return {
      lineId: bytes32(l.lineId),
      lineVersion: integer(l.lineVersion, 1, 1_000_000),
      order: i,
      text: text(l.text, 32768),
    };
  });
  insist(
    new Set(lines.map((l) => l.lineId)).size === lines.length,
    "duplicate_lyric_occurrence",
  );
  const language = text(o.language, 35);
  insist(
    /^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(language),
    "invalid_language",
  );
  return {
    ...identity(o),
    schema: "pirate.song-lyrics/1",
    revision: integer(o.revision, 1, Number.MAX_SAFE_INTEGER),
    language,
    sourceText,
    sourceSha256: bytes32(o.sourceSha256),
    lines,
  };
}
export function createLyrics(
  id: PublicationIdentity,
  sourceText: string,
  language = "und",
): LyricManifest {
  return validateLyrics({
    ...id,
    schema: "pirate.song-lyrics/1",
    revision: 1,
    language,
    sourceText,
    sourceSha256: hashText(sourceText),
    lines: lyricTexts(sourceText).map((line, order) => ({
      lineId: publicId(),
      lineVersion: 1,
      order,
      text: line,
    })),
  });
}
