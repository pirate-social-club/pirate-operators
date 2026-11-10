// Independent complete supported lyric schema, shared by the two reference
// activity adapters. This is not an import of the application's lyric validator.
import { sha256, toHex, type Hex } from "viem";
import type { Header } from "./facts.ts";
import { canonical, requireFact } from "./checks.ts";
import {
  exactDocument,
  documentInteger,
  documentHash,
  documentText,
  documentAddress,
} from "./document-rules.ts";
export function fullLyrics(
  source: Record<string, any>,
  song: Header["song"],
  hash: Hex,
) {
  exactDocument(source, [
    "schema",
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
  requireFact(
    source.schema === "pirate.song-lyrics/1" &&
      [6343, 31337].includes(source.chainId) &&
      BigInt(source.chainId) === song.chainId &&
      source.postsContract === song.posts.toLowerCase() &&
      source.communityId === song.communityId &&
      source.postId === song.postId &&
      sha256(toHex(canonical(source))) === hash,
    "lyric_binding_changed",
  );
  documentAddress(source.postsContract);
  documentHash(source.communityId);
  documentHash(source.postId);
  documentInteger(source.revision, 1);
  const text = documentText(source.sourceText, 32768),
    language = documentText(source.language, 35);
  requireFact(
    sha256(toHex(text)) === documentHash(source.sourceSha256) &&
      /^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(language) &&
      Array.isArray(source.lines) &&
      source.lines.length <= 2000,
    "invalid_lyric_source",
  );
  const expected = text.split(/\r?\n/).filter((line) => line.trim().length > 0),
    ids = new Set<string>();
  requireFact(
    expected.length === source.lines.length,
    "lyric_coverage_changed",
  );
  source.lines.forEach((line: any, i: number) => {
    exactDocument(line, ["lineId", "lineVersion", "order", "text"]);
    requireFact(
      line.order === i &&
        documentText(line.text, 32768) === expected[i] &&
        !ids.has(documentHash(line.lineId)),
      "lyric_occurrence_changed",
    );
    ids.add(line.lineId);
    documentInteger(line.lineVersion, 1, 1000000);
  });
  return source.lines as {
    lineId: Hex;
    lineVersion: number;
    order: number;
    text: string;
  }[];
}
