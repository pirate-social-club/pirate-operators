// The LearningRecords encoding, version 1 (docs/learning-records-contract.md).
// Shared by the operator's publisher and the independent reader, and checked
// against fixtures/learning-records-v1.json.
import {
  concat,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  stringToBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { check } from "./index.ts";
import type { KaraokeManifest, KaraokeResultBody, LineStatus } from "./payments.ts";

export const RECORDS_EPOCH_START = 1793552400; // 2026-11-01 17:00 UTC
export const RECORDS_PERIOD_SECONDS = 86400;
/** How long a learner's consent may wait before its attempt is opened on chain. */
export const CONSENT_LIFETIME_S = 7 * 86400;

export const textKey = (text: string) => keccak256(stringToBytes(text));
export const ACTIVITY_KARAOKE = textKey("karaoke");
export const scoringPolicyOf = (version: number) => textKey(`karaoke-scoring/${version}`);
export const lineKeyOf = (lineId: string) => textKey(lineId);

export const LINE_STATUS_CODES: Record<LineStatus, number> = {
  assessed: 1,
  silent: 2,
  unpaid: 3,
  unmeasured: 4,
  unattempted: 5,
};
export const LINE_STATUSES = Object.fromEntries(
  Object.entries(LINE_STATUS_CODES).map(([status, code]) => [code, status]),
) as Record<number, LineStatus>;
export type CompletionStatus = KaraokeResultBody["status"];
export const COMPLETION_STATUS_CODES: Record<CompletionStatus, number> = {
  completed: 1,
  abandoned: 2,
  expired: 3,
  payment_missing: 4,
};
export const COMPLETION_STATUSES = Object.fromEntries(
  Object.entries(COMPLETION_STATUS_CODES).map(([status, code]) => [code, status]),
) as Record<number, CompletionStatus>;

export const periodOf = (timestamp: number) => {
  check(timestamp >= RECORDS_EPOCH_START, "before_epoch");
  return Math.floor((timestamp - RECORDS_EPOCH_START) / RECORDS_PERIOD_SECONDS);
};

export interface SongKey {
  chainId: number;
  posts: Address;
  communityId: Hex;
  postId: Hex;
}
export const songKeyOf = (s: SongKey) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
      [BigInt(s.chainId), s.posts, s.communityId, s.postId],
    ),
  );
/** The stand-in until a posts contract exists; not a stable song identity. */
export const standInSong = (chainId: number, communityId: string, songHash: Hex): SongKey => ({
  chainId,
  posts: zeroAddress,
  communityId: textKey(communityId),
  postId: songHash,
});

export const leafOf = (ordinal: number, lineId: string, lineVersion: number) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
      [BigInt(ordinal), lineKeyOf(lineId), BigInt(lineVersion)],
    ),
  );
const pair = (a: Hex, b: Hex) => keccak256(BigInt(a) < BigInt(b) ? concat([a, b]) : concat([b, a]));
/** Levels from the leaves to the root; an odd last node is promoted unchanged. */
export function merkleLevels(leaves: readonly Hex[]) {
  check(leaves.length > 0, "empty_tree");
  const levels: Hex[][] = [[...leaves]];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
    levels.push(next);
  }
  return levels;
}
export const merkleRoot = (leaves: readonly Hex[]) => merkleLevels(leaves).at(-1)![0];
/** Siblings from the leaf upward; a promoted level contributes none. */
export function merkleProof(leaves: readonly Hex[], index: number) {
  const proof: Hex[] = [];
  for (const level of merkleLevels(leaves).slice(0, -1)) {
    const sibling = index ^ 1;
    if (sibling < level.length) proof.push(level[sibling]);
    index >>= 1;
  }
  return proof;
}
export const manifestLeaves = (manifest: KaraokeManifest) =>
  manifest.lines.map((line) => leafOf(line.ordinal, line.lineId, line.lineVersion));
export const linesRootOf = (manifest: KaraokeManifest) => merkleRoot(manifestLeaves(manifest));

export interface LineRecord {
  attemptId: Hex;
  ordinal: number;
  lineKey: Hex;
  lineVersion: number;
  status: number;
  scoreBps: number;
  final: boolean;
  revision: number;
}
export const recordHashOf = (r: LineRecord) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "uint32" },
        { type: "uint8" },
        { type: "uint16" },
        { type: "bool" },
        { type: "uint32" },
      ],
      [r.attemptId, r.ordinal, r.lineKey, r.lineVersion, r.status, r.scoreBps, r.final, r.revision],
    ),
  );
export const recordsHashOf = (recordHashes: readonly Hex[]) => keccak256(concat([...recordHashes]));

export interface Consent {
  learner: Address;
  attemptId: Hex;
  songKey: Hex;
  contentRevision: Hex;
  linesRoot: Hex;
  linesTotal: number;
  activity: Hex;
  grader: Address;
  scoringPolicy: Hex;
  expiresAt: number;
}
export const consentTypes = {
  Consent: [
    { name: "learner", type: "address" },
    { name: "attemptId", type: "bytes32" },
    { name: "songKey", type: "bytes32" },
    { name: "contentRevision", type: "bytes32" },
    { name: "linesRoot", type: "bytes32" },
    { name: "linesTotal", type: "uint16" },
    { name: "activity", type: "bytes32" },
    { name: "grader", type: "address" },
    { name: "scoringPolicy", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;
export const recordsDomain = (chainId: number, records: Address) => ({
  name: "Pirate Learning Records",
  version: "1",
  chainId,
  verifyingContract: records,
});
export const consentMessage = (c: Consent) => ({ ...c, expiresAt: BigInt(c.expiresAt) });

export const recordsAbi = parseAbi([
  "struct Consent { address learner; bytes32 attemptId; bytes32 songKey; bytes32 contentRevision; bytes32 linesRoot; uint16 linesTotal; bytes32 activity; address grader; bytes32 scoringPolicy; uint64 expiresAt; }",
  "struct SongKey { uint256 chainId; address posts; bytes32 communityId; bytes32 postId; }",
  "struct LineInput { uint16 ordinal; bytes32 lineKey; uint32 lineVersion; uint8 status; uint16 scoreBps; bool final_; bytes32[] proof; }",
  "struct Completion { uint64 completedAt; uint8 status; uint16 unmeasuredCount; bool hasRewardScore; uint16 rewardScoreBps; }",
  "function openAttempt(Consent c, bytes signature, SongKey song)",
  "function assessLines(bytes32 attemptId, LineInput[] inputs)",
  "function completeAttempt(bytes32 attemptId, Completion c)",
  "event AttemptOpened(bytes32 indexed attemptId, address indexed learner, bytes32 indexed songKey, SongKey song, bytes32 activity, address grader, bytes32 scoringPolicy, bytes32 contentRevision, bytes32 linesRoot, uint16 linesTotal)",
  "event LineAssessed(bytes32 indexed attemptId, address indexed learner, uint16 indexed ordinal, bytes32 lineKey, uint32 lineVersion, uint8 status, uint16 scoreBps, bool hasScore, bool final_, uint32 revision, bytes32 supersedes, bytes32 recordHash)",
  "event AttemptCompleted(bytes32 indexed attemptId, address indexed learner, bytes32 indexed songKey, bytes32 activity, uint64 completedAt, uint64 periodId, bytes32 qualificationPolicy, uint8 status, bytes32 recordsHash, uint16 linesTotal, uint16 unmeasuredCount, bool hasRewardScore, uint16 rewardScoreBps, uint32 revision)",
]);
