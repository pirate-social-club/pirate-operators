// Independent V3 Study wire/source/qualification checks. No production Study
// codec, selection, grading, result reducer or qualification helper is imported.
import { hexToBytes, keccak256, sha256, toHex, type Hex } from "viem";
import type { Header, ReferenceSnapshot } from "./facts.ts";
import { canonical, publicDocument, requireFact } from "./checks.ts";

// Frozen public scoring-version identifier. This literal is configuration, not
// a call into the application's scoring or queue implementation.
export const referenceStudyScoring =
  "0x19688dbe07816ff88973ea5e54780108c473cebc2d68e25c194627ade7289eee";
export interface ReferenceStudyOutcome {
  ordinal: number;
  status: number;
  grade: number | null;
}
export function decodeStudy(r: Header, wire: Hex): ReferenceStudyOutcome[] {
  requireFact(
    r.activity === 2 &&
      Number.isInteger(r.linesTotal) &&
      r.linesTotal >= 4 &&
      r.linesTotal <= 10,
    "study_count_or_activity",
  );
  requireFact(/^0x(?:[0-9a-f]{2})*$/i.test(wire), "study_invalid_wire");
  const bytes = hexToBytes(wire);
  requireFact(bytes.length === r.linesTotal * 3, "study_incomplete_coverage");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    selected = new Uint8Array(r.linesTotal * 2),
    selectedView = new DataView(selected.buffer);
  const ordinals = new Set<number>(),
    result: ReferenceStudyOutcome[] = [];
  for (let i = 0; i < r.linesTotal; i++) {
    const ordinal = view.getUint16(i * 3),
      status = view.getUint8(i * 3 + 2);
    requireFact(
      ordinal > 0 &&
        ordinal <= 2000 &&
        !ordinals.has(ordinal) &&
        status >= 1 &&
        status <= 5,
      "study_invalid_outcome",
    );
    ordinals.add(ordinal);
    selectedView.setUint16(i * 2, ordinal);
    result.push({
      ordinal,
      status,
      grade: status === 1 ? 10000 : status === 2 ? 0 : null,
    });
  }
  requireFact(
    keccak256(selected) === r.exercisesHash &&
      (r.status !== 1 || result.every((o) => o.status === 1 || o.status === 2)),
    "study_exercises_or_completion_changed",
  );
  return result;
}
const cue = (text: string) =>
  /^\[[^\[\]\r\n]*\]$/.test(text.trim()) ||
  /^\(\s*instrumental(?:\s+solo|\s+breakdown(?:\s+with\s+vocal\s+chops)?)?\s*\)$/iu.test(
    text.trim(),
  );
const identity = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/[‘’‛′`´]/gu, "'")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
const hex32 = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
export function studySource(
  r: Header,
  source: Record<string, any>,
  outcomes: ReferenceStudyOutcome[],
) {
  requireFact(
    Object.keys(source).sort().join(",") ===
      [
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
      ]
        .sort()
        .join(",") &&
      source.schema === "pirate.song-lyrics/1" &&
      BigInt(source.chainId) === r.song.chainId &&
      source.postsContract === r.song.posts.toLowerCase() &&
      source.communityId === r.song.communityId &&
      source.postId === r.song.postId &&
      Number.isSafeInteger(source.revision) &&
      source.revision >= 1 &&
      typeof source.language === "string" &&
      /^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(source.language) &&
      typeof source.sourceText === "string" &&
      source.sourceText.length <= 32768 &&
      sha256(toHex(source.sourceText)) === source.sourceSha256 &&
      Array.isArray(source.lines) &&
      source.lines.length <= 2000 &&
      sha256(toHex(canonical(source))) === r.contentRevision,
    "study_source_binding_changed",
  );
  const textLines = source.sourceText
    .split(/\r?\n/)
    .filter((text: string) => text.trim().length > 0);
  requireFact(
    textLines.length === source.lines.length,
    "study_source_shortened",
  );
  const ids = new Set<string>(),
    seen = new Set<string>(),
    eligible = new Set<number>();
  for (let i = 0; i < source.lines.length; i++) {
    const line = source.lines[i];
    requireFact(
      Object.keys(line).sort().join(",") ===
        ["lineId", "lineVersion", "order", "text"].sort().join(",") &&
        line.order === i &&
        line.text === textLines[i] &&
        hex32(line.lineId) &&
        !ids.has(line.lineId) &&
        Number.isSafeInteger(line.lineVersion) &&
        line.lineVersion >= 1 &&
        line.lineVersion <= 1000000,
      "study_source_occurrence_changed",
    );
    ids.add(line.lineId);
    const normalized = identity(line.text);
    if (
      !normalized ||
      line.text.length > 512 ||
      cue(line.text) ||
      seen.has(normalized)
    )
      continue;
    seen.add(normalized);
    eligible.add(i + 1);
  }
  requireFact(
    outcomes.length === r.linesTotal &&
      outcomes.every((o) => eligible.has(o.ordinal)),
    "study_source_ineligible_selection",
  );
  return true;
}
export function studyPolicy(
  snapshot: ReferenceSnapshot,
  uri: string,
  hash: Hex,
) {
  const d = publicDocument(snapshot, uri, hash);
  requireFact(
    Object.keys(d).sort().join(",") ===
      [
        "schema",
        "activity",
        "graders",
        "scoringPolicy",
        "terminalStatuses",
        "requireAllFirstPass",
        "minCorrectNumerator",
        "minCorrectDenominator",
      ]
        .sort()
        .join(",") &&
      d.schema === "pirate.study-qualification/1" &&
      d.activity === 2 &&
      Array.isArray(d.graders) &&
      d.graders.length > 0 &&
      d.graders.every(
        (g: unknown) => typeof g === "string" && /^0x[0-9a-f]{40}$/.test(g),
      ) &&
      d.scoringPolicy === referenceStudyScoring &&
      Array.isArray(d.terminalStatuses) &&
      d.terminalStatuses.length === 1 &&
      d.terminalStatuses[0] === 1 &&
      d.requireAllFirstPass === true &&
      d.minCorrectNumerator === 7 &&
      d.minCorrectDenominator === 10,
    "study_unsupported_policy",
  );
  return {
    activity: 2,
    graders: d.graders as string[],
    scoringPolicies: [d.scoringPolicy as Hex],
    terminalStatuses: [1],
    minScoreBps: 7000,
    maxUnmeasuredBps: 0,
  };
}
export function studyScore(outcomes: readonly ReferenceStudyOutcome[]) {
  requireFact(
    outcomes.length >= 4 &&
      outcomes.length <= 10 &&
      new Set(outcomes.map((o) => o.ordinal)).size === outcomes.length &&
      outcomes.every(
        (o) =>
          Number.isInteger(o.ordinal) &&
          o.ordinal >= 1 &&
          o.ordinal <= 2000 &&
          Number.isInteger(o.status) &&
          o.status >= 1 &&
          o.status <= 5,
      ),
    "study_invalid_score_input",
  );
  const correct = outcomes.filter((o) => o.status === 1).length,
    graded = outcomes.filter((o) => o.status === 1 || o.status === 2).length;
  return {
    total: outcomes.length,
    correct,
    graded,
    scoreBps:
      graded === outcomes.length
        ? Math.floor((correct * 10000) / outcomes.length)
        : null,
    qualifies:
      graded === outcomes.length && correct * 10 >= outcomes.length * 7,
  };
}
