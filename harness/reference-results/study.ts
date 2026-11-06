// Independent V3 Study wire/source/qualification checks. No production Study
// codec, selection, grading, result reducer or qualification helper is imported.
import { hexToBytes, keccak256, sha256, toHex, type Hex } from "viem";
import { fullLyrics } from "./lyrics.ts";
import type { Header, ReferenceSnapshot } from "./facts.ts";
import { publicDocument, requireFact } from "./checks.ts";

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
export function studySource(
  r: Header,
  source: Record<string, any>,
  outcomes: ReferenceStudyOutcome[],
) {
  const lines = fullLyrics(source, r.song, r.contentRevision);
  const seen = new Set<string>(),
    eligible = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
  const d = publicDocument(snapshot, uri, hash, 65536);
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

/** Full source bytes are captured from their published media URI, which may
 * use a UnixFS CID. A digest cannot manufacture that URI for large documents. */
export function studyDocument(snapshot: ReferenceSnapshot, hash: Hex) {
  for (const [uri, wire] of Object.entries(snapshot.documents)) {
    if (sha256(wire) === hash)
      return publicDocument(snapshot, uri, hash, 1024 * 1024);
  }
  throw Error("reference_study_document_unavailable");
}
