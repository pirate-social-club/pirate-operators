// Encoding 2. Karaoke terminal bundles; private transcripts never enter this ABI.
import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { check } from "./index.ts";
import {
  LINE_STATUS_CODES,
  RECORDS_EPOCH_START,
  type SongKey,
} from "./records.ts";
import type { LineOutcome } from "./payments.ts";

export const RESULT_ACTIVITY_KARAOKE = 1;
export interface Enrollment {
  learner: Address;
  communityId: Hex;
  activities: bigint;
  publicityPolicy: Hex;
  expiresAt: bigint;
  nonce: bigint;
}
export const enrollmentTypes = {
  Enrollment: [
    { name: "learner", type: "address" },
    { name: "communityId", type: "bytes32" },
    { name: "activities", type: "uint256" },
    { name: "publicityPolicy", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;
export const revocationTypes = {
  Revocation: [
    { name: "learner", type: "address" },
    { name: "nonce", type: "uint64" },
  ],
} as const;
export const resultsDomain = (chainId: number, verifyingContract: Address) => ({
  name: "Pirate Learning Results",
  version: "2",
  chainId,
  verifyingContract,
});
export const enrollmentIdOf = (
  chainId: number,
  contract: Address,
  message: Enrollment,
) =>
  hashTypedData({
    domain: resultsDomain(chainId, contract),
    types: enrollmentTypes,
    primaryType: "Enrollment",
    message,
  });

export const enrollmentStruct =
  "struct Enrollment { address learner; bytes32 communityId; uint256 activities; bytes32 publicityPolicy; uint64 expiresAt; uint64 nonce; }";
export const resultStruct =
  "struct Result { bytes32 sessionId; address learner; bytes32 enrollmentId; Song song; bytes32 contentRevision; bytes32 exercisesHash; uint16 linesTotal; uint8 activity; address grader; bytes32 scoringPolicy; bytes32 qualificationPolicy; uint64 startedAt; uint64 completedAt; uint8 status; uint32 revision; bytes32 supersedes; }";
export const songStruct =
  "struct Song { uint256 chainId; address posts; bytes32 communityId; bytes32 postId; }";
export const resultsAbi = parseAbi([
  enrollmentStruct,
  songStruct,
  resultStruct,
  "function enroll(Enrollment e, bytes signature)",
  "function revoke(address learner, uint64 nonce, bytes signature)",
  "function publish(Result r, bytes outcomes)",
  "function correct(Result previous, bytes oldOutcomes, bytes outcomes, uint8 status)",
  "function invalidate(Result previous, bytes outcomes, bytes32 reason)",
  "function enrollments(address learner) view returns (bytes32 id, uint256 activities, uint64 issuedAt, uint64 expiresAt)",
  "function nextNonce(address learner) view returns (uint64)",
  "function publicityPolicy() view returns (bytes32)",
  "function communityId() view returns (bytes32)",
  "function commitments(bytes32 sessionId) view returns (bytes32)",
  "function policyFor(uint64 period) view returns (bytes32)",
  "event Enrolled(address indexed learner, bytes32 indexed enrollmentId, Enrollment enrollment, uint64 issuedAt)",
  "event Revoked(address indexed learner, bytes32 indexed enrollmentId, uint64 nonce)",
  "event ResultPublished(bytes32 indexed sessionId, address indexed learner, uint32 indexed revision, Result result, bytes outcomes, bytes32 commitment, address publisher)",
  "event PolicyActivated(bytes32 indexed policyHash, string policyURI, uint64 effectivePeriod, uint8 clockVersion)",
  "event EligibilityChanged(address indexed learner, bool eligible, uint64 effectiveAt, bytes32 reasonCode)",
]);
export interface TerminalResult {
  sessionId: Hex;
  learner: Address;
  enrollmentId: Hex;
  song: Omit<SongKey, "chainId"> & { chainId: bigint };
  contentRevision: Hex;
  exercisesHash: Hex;
  linesTotal: number;
  activity: number;
  grader: Address;
  scoringPolicy: Hex;
  qualificationPolicy: Hex;
  startedAt: bigint;
  completedAt: bigint;
  status: number;
  revision: number;
  supersedes: Hex;
}
export const orderedExercisesHash = (count: number) => {
  check(
    Number.isInteger(count) && count > 0 && count <= 500,
    "invalid_coverage",
  );
  return keccak256(
    concat(
      Array.from({ length: count }, (_, i) => numberToHex(i + 1, { size: 2 })),
    ),
  );
};
export function packOutcomes(
  lines: readonly Pick<LineOutcome, "status" | "scoreBps">[],
): Hex {
  orderedExercisesHash(lines.length);
  return concat(
    lines.map((line, i) => {
      const status = LINE_STATUS_CODES[line.status];
      check(
        status !== undefined &&
          (status === 1
            ? Number.isInteger(line.scoreBps) &&
              line.scoreBps! >= 0 &&
              line.scoreBps! <= 10000
            : line.scoreBps === null),
        "invalid_grade",
      );
      return concat([
        numberToHex(i + 1, { size: 2 }),
        numberToHex(status, { size: 1 }),
        numberToHex(line.scoreBps ?? 0, { size: 2 }),
      ]);
    }),
  );
}
export function unpackOutcomes(packed: Hex, count: number) {
  orderedExercisesHash(count);
  check(
    /^0x[0-9a-f]*$/i.test(packed) && packed.length === 2 + count * 10,
    "invalid_coverage",
  );
  const names = [
    "",
    "assessed",
    "silent",
    "unpaid",
    "unmeasured",
    "unattempted",
  ] as const;
  return Array.from({ length: count }, (_, i) => {
    const word = packed.slice(2 + i * 10, 12 + i * 10);
    const ordinal = parseInt(word.slice(0, 4), 16),
      status = parseInt(word.slice(4, 6), 16),
      score = parseInt(word.slice(6, 10), 16);
    check(
      ordinal === i + 1 &&
        status >= 1 &&
        status <= 5 &&
        (status === 1 ? score <= 10000 : score === 0),
      "invalid_grade",
    );
    return {
      ordinal,
      status: names[status],
      scoreBps: status === 1 ? score : null,
    };
  });
}
const resultParameter = resultsAbi.find(
  (x) => x.type === "function" && x.name === "publish",
)!.inputs[0];
export const resultCommitment = (result: TerminalResult, outcomes: Hex) =>
  keccak256(
    encodeAbiParameters(
      [resultParameter, { type: "bytes" }],
      [result, outcomes],
    ),
  );
export const resultPeriod = (completedAt: bigint) => {
  check(completedAt >= BigInt(RECORDS_EPOCH_START), "before_epoch");
  return (completedAt - BigInt(RECORDS_EPOCH_START)) / 86400n;
};
