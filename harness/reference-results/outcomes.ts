import { encodeAbiParameters, hexToBytes, keccak256, type Hex } from "viem";
import { abi, type Header } from "./facts.ts";
import { canonical, lower, requireFact } from "./checks.ts";

const publication = abi.find(
  (x) => x.type === "function" && x.name === "publish",
)!;
export function commitment(result: Header, wire: Hex) {
  return keccak256(encodeAbiParameters(publication.inputs, [result, wire]));
}
export function immutableContext(r: Header) {
  return canonical([
    r.sessionId,
    lower(r.learner),
    r.enrollmentId,
    String(r.song.chainId),
    lower(r.song.posts),
    r.song.communityId,
    r.song.postId,
    r.contentRevision,
    r.exercisesHash,
    r.linesTotal,
    r.activity,
    lower(r.grader),
    r.scoringPolicy,
    r.qualificationPolicy,
    String(r.startedAt),
    String(r.completedAt),
  ]);
}
export function decodeOutcomes(r: Header, wire: Hex) {
  const bytes = hexToBytes(wire);
  requireFact(
    r.linesTotal >= 1 &&
      r.linesTotal <= 500 &&
      bytes.length === r.linesTotal * 5,
    "incomplete_outcomes",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ordinals = new Uint8Array(r.linesTotal * 2);
  const ordered = new DataView(ordinals.buffer);
  const outcomes = [];
  for (let i = 0; i < r.linesTotal; i++) {
    const ordinal = view.getUint16(i * 5),
      status = view.getUint8(i * 5 + 2),
      score = view.getUint16(i * 5 + 3);
    requireFact(
      ordinal === i + 1 &&
        status >= 1 &&
        status <= 5 &&
        (status === 1 ? score <= 10000 : score === 0),
      "invalid_outcome",
    );
    ordered.setUint16(i * 2, ordinal);
    outcomes.push({ ordinal, status, grade: status === 1 ? score : null });
  }
  requireFact(keccak256(ordinals) === r.exercisesHash, "exercise_hash_changed");
  return outcomes;
}
