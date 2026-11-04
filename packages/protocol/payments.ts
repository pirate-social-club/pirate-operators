// Operator payments and per-line karaoke billing, docs/operator-payments.md.
// Pure rules shared by the community, the operator and the verifier.
import {
  hashTypedData,
  keccak256,
  parseAbi,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { check, digest } from "./index.ts";

export const RECONNECT_WINDOW_S = 30;
export const PAYMENT_GRACE_S = 10;
export const PACE_AHEAD_MS = 15000;
/** Purchases are back-dated by this much to absorb clock skew with the chain. */
export const CLOCK_SKEW_S = 300;
export const MAX_AUTHORIZATION_LIFETIME_S = 3600;
export const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

export interface OperatorQuote {
  operator: Address;
  recipient: Address;
  chainId: number;
  payments: Address;
  token: Address;
  admissionPrice: string;
  segmentPrice: string;
  scoringPolicy: string;
  maxSegmentMs: number;
  maxUnpaidRun: number;
  validFrom: number;
  validUntil: number;
}
/** A quote ID is the hash of the signed quote body, so it never names other terms. */
export const quoteIdOf = (quote: OperatorQuote): Hex => digest(quote);

/** The EIP-712 purchase a community signs; amounts and times as decimal strings and integers. */
export interface Purchase {
  community: Address;
  unit: Hex;
  ticketId: Hex;
  quoteId: Hex;
  operator: Address;
  recipient: Address;
  token: Address;
  amount: string;
  validAfter: number;
  expiresAt: number;
}
export interface SignedPurchase {
  purchase: Purchase;
  signature: Hex;
}
export const purchaseTypes = {
  Purchase: [
    { name: "community", type: "address" },
    { name: "unit", type: "bytes32" },
    { name: "ticketId", type: "bytes32" },
    { name: "quoteId", type: "bytes32" },
    { name: "operator", type: "address" },
    { name: "recipient", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "validAfter", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;
export const purchaseDomain = (chainId: number, payments: Address) => ({
  name: "Pirate Operator Payments",
  version: "1",
  chainId,
  verifyingContract: payments,
});
export const purchaseMessage = (p: Purchase) => ({
  ...p,
  amount: BigInt(p.amount),
  validAfter: BigInt(p.validAfter),
  expiresAt: BigInt(p.expiresAt),
});
export const purchaseDigestOf = (p: Purchase, chainId: number, payments: Address) =>
  hashTypedData({
    domain: purchaseDomain(chainId, payments),
    types: purchaseTypes,
    primaryType: "Purchase",
    message: purchaseMessage(p),
  });
export const unitHash = (unitKey: string) => keccak256(stringToBytes(unitKey));
export const segmentUnit = (ticketId: Hex, segmentId: string, take: number) =>
  `segment:${ticketId}:${segmentId}:${take}`;
export const admissionUnit = (jobId: Hex) => `admission:${jobId}`;

export const paymentsAbi = parseAbi([
  "function signer(address community) view returns (address)",
  "function balance(address community, address token) view returns (uint256)",
  "function redemption(address community, bytes32 unit) view returns (bytes32)",
  "function closed(address community, bytes32 ticketId, address operator) view returns (bool)",
  "function redeem((address community, bytes32 unit, bytes32 ticketId, bytes32 quoteId, address operator, address recipient, address token, uint256 amount, uint64 validAfter, uint64 expiresAt) p, bytes signature)",
  "function closeTicket(address community, bytes32 ticketId)",
  "event Purchased(address indexed community, bytes32 indexed unit, address indexed operator, bytes32 digest, bytes32 ticketId, bytes32 quoteId, address recipient, address token, uint256 amount)",
]);

export interface AttemptStart {
  ticketId: Hex;
  attemptId: Hex;
  startedAt: number;
}

export interface ManifestWord {
  text: string;
  startMs: number;
  endMs: number;
}
export interface ManifestLine {
  lineId: string;
  lineVersion: number;
  ordinal: number;
  text: string;
  startMs: number;
  endMs: number;
  words: ManifestWord[];
}
export interface ManifestSegment {
  segmentId: string;
  startMs: number;
  endMs: number;
  lineIds: string[];
}
export interface KaraokeManifest {
  manifestVersion: "pirate.karaoke.manifest/1";
  songHash: Hex;
  lines: ManifestLine[];
  segments: ManifestSegment[];
}

/** Every scored line belongs to exactly one segment; no line is split. */
export function validateManifest(manifest: KaraokeManifest, maxSegmentMs: number) {
  check(manifest.manifestVersion === "pirate.karaoke.manifest/1", "invalid_manifest");
  check(manifest.lines.length > 0 && manifest.lines.length <= 500, "invalid_manifest");
  const lines = new Map<string, ManifestLine>();
  manifest.lines.forEach((line, i) => {
    check(
      line.ordinal === i + 1 &&
        !lines.has(line.lineId) &&
        /^[A-Za-z0-9_-]{1,64}$/.test(line.lineId) &&
        Number.isSafeInteger(line.lineVersion) &&
        line.lineVersion >= 1 &&
        line.startMs >= 0 &&
        line.endMs > line.startMs,
      "invalid_manifest",
    );
    lines.set(line.lineId, line);
  });
  const covered = new Set<string>();
  const segmentIds = new Set<string>();
  let previousEnd = -1;
  for (const segment of manifest.segments) {
    check(
      /^[A-Za-z0-9_-]{1,64}$/.test(segment.segmentId) &&
        !segmentIds.has(segment.segmentId) &&
        segment.startMs >= previousEnd &&
        segment.endMs > segment.startMs &&
        segment.endMs - segment.startMs <= maxSegmentMs &&
        segment.lineIds.length > 0,
      "invalid_manifest",
    );
    segmentIds.add(segment.segmentId);
    previousEnd = segment.endMs;
    for (const lineId of segment.lineIds) {
      const line = lines.get(lineId);
      check(
        line &&
          !covered.has(lineId) &&
          line.startMs >= segment.startMs &&
          line.endMs <= segment.endMs,
        "invalid_manifest",
      );
      covered.add(lineId);
    }
  }
  check(covered.size === lines.size, "invalid_manifest");
}
export const songEndMs = (manifest: KaraokeManifest) =>
  manifest.segments[manifest.segments.length - 1].endMs;
/**
 * A line is reached when it begins before the performance cutoff, measured
 * from `startedAt`. The result builder and the verifier share this rule.
 */
export const lineReached = (line: ManifestLine, startedAt: number, performanceEndedAt: number) =>
  line.startMs < (performanceEndedAt - startedAt) * 1000;

/** Section 5.4: "early", "open", or "closed" once the segment has passed. */
export function paymentWindow(
  startedAt: number,
  segment: ManifestSegment,
  nowSeconds: number,
  paceAheadMs = PACE_AHEAD_MS,
): "early" | "open" | "closed" {
  const now = nowSeconds * 1000;
  const start = startedAt * 1000;
  if (now < start + segment.startMs - paceAheadMs) return "early";
  return now <= start + segment.endMs ? "open" : "closed";
}

/**
 * `unattempted`: the attempt ended before the line began, whether or not it
 * was paid ahead. It carries no score and counts zero toward the reward.
 */
export type LineStatus = "assessed" | "silent" | "unpaid" | "unmeasured" | "unattempted";
/** The educational record: a score exists only for paid, measured, recognized singing. */
export interface LineOutcome {
  lineId: string;
  lineVersion: number;
  status: LineStatus;
  scoreBps: number | null;
}
export interface RedemptionRef {
  chainId: number;
  payments: Address;
  unit: Hex;
  digest: Hex;
  txHash: Hex;
}
export interface BillingEntry {
  segmentId: string;
  take: number;
  lineIds: string[];
  redemption: RedemptionRef | null;
}

/** Reward accounting: unpaid, silent and unattempted count zero; unmeasured leaves the denominator. */
export function rewardScore(lines: readonly Pick<LineOutcome, "status" | "scoreBps">[]) {
  const linesTotal = lines.length;
  const unmeasuredCount = lines.filter((l) => l.status === "unmeasured").length;
  const denominator = linesTotal - unmeasuredCount;
  let sum = 0;
  for (const line of lines) if (line.status === "assessed") sum += line.scoreBps!;
  return {
    linesTotal,
    unmeasuredCount,
    rewardScoreBps: denominator > 0 ? Math.floor(sum / denominator) : null,
  };
}

export interface KaraokeResultBody {
  attemptId: Hex;
  ticketId: Hex;
  communityId: string;
  participant: Address;
  songHash: Hex;
  manifestSha256: Hex;
  quoteId: Hex;
  community: Address;
  mode: "performance";
  status: "completed" | "abandoned" | "expired" | "payment_missing";
  finality: "final";
  revision: number;
  startedAt: number;
  lastAudioAt: number | null;
  /** When singing stopped: the cutoff for reachability, never after endedAt. */
  performanceEndedAt: number;
  /** When the operator decided the attempt was over; payment grace runs from here. */
  endedAt: number;
  closedAtBlock: number;
  summary: { scoreBps: number; coverageBps: number; scoringVersion: number };
  summaryHash: Hex;
  lines: LineOutcome[];
  billing: BillingEntry[];
  linesHash: Hex;
  billingHash: Hex;
  linesTotal: number;
  unmeasuredCount: number;
  rewardScoreBps: number | null;
  paidCount: number;
  paidAmount: string;
}

/** Section 6, items 4 and 5: every list checked against the pinned manifest. */
export function verifyKaraokeResult(
  result: KaraokeResultBody,
  manifest: KaraokeManifest,
  quote: OperatorQuote,
) {
  check(digest(manifest) === result.manifestSha256, "manifest_mismatch");
  check(quoteIdOf(quote) === result.quoteId, "quote_mismatch");
  check(result.lines.length === manifest.lines.length, "line_list_mismatch");
  check(
    Number.isSafeInteger(result.startedAt) &&
      Number.isSafeInteger(result.performanceEndedAt) &&
      Number.isSafeInteger(result.endedAt) &&
      result.startedAt <= result.performanceEndedAt &&
      result.performanceEndedAt <= result.endedAt &&
      result.performanceEndedAt - result.startedAt <= Math.ceil(songEndMs(manifest) / 1000),
    "invalid_timing",
  );
  result.lines.forEach((line, i) => {
    const expected = manifest.lines[i];
    check(
      line.lineId === expected.lineId && line.lineVersion === expected.lineVersion,
      "line_list_mismatch",
    );
    // Exactly the lines that begin after the cutoff are unattempted.
    check(
      lineReached(expected, result.startedAt, result.performanceEndedAt) ===
        (line.status !== "unattempted"),
      "reachability_mismatch",
    );
    check(
      ["assessed", "silent", "unpaid", "unmeasured", "unattempted"].includes(line.status) &&
        (line.status === "assessed"
          ? Number.isSafeInteger(line.scoreBps) &&
            line.scoreBps! >= 0 &&
            line.scoreBps! <= 10000
          : line.scoreBps === null),
      "invalid_line_outcome",
    );
  });
  check(result.billing.length === manifest.segments.length, "billing_list_mismatch");
  const status = new Map(result.lines.map((l) => [l.lineId, l.status]));
  const digests = new Set<string>();
  let paidCount = 0;
  result.billing.forEach((entry, i) => {
    const segment = manifest.segments[i];
    check(
      entry.segmentId === segment.segmentId &&
        entry.take === 0 &&
        digest(entry.lineIds) === digest(segment.lineIds),
      "billing_list_mismatch",
    );
    const r = entry.redemption;
    if (r) {
      paidCount += 1;
      check(
        r.chainId === quote.chainId &&
          r.payments.toLowerCase() === quote.payments.toLowerCase() &&
          r.unit === unitHash(segmentUnit(result.ticketId, segment.segmentId, 0)) &&
          !digests.has(r.digest),
        "billing_list_mismatch",
      );
      digests.add(r.digest);
    }
    // A paid line is never unpaid; an unpaid line is unpaid or unattempted.
    for (const lineId of segment.lineIds)
      check(
        r
          ? status.get(lineId) !== "unpaid"
          : status.get(lineId) === "unpaid" || status.get(lineId) === "unattempted",
        "line_payment_mismatch",
      );
  });
  const reward = rewardScore(result.lines);
  check(
    result.linesHash === digest(result.lines) &&
      result.billingHash === digest(result.billing) &&
      result.summaryHash === digest(result.summary) &&
      result.linesTotal === reward.linesTotal &&
      result.unmeasuredCount === reward.unmeasuredCount &&
      result.rewardScoreBps === reward.rewardScoreBps &&
      result.paidCount === paidCount &&
      result.paidAmount === (BigInt(paidCount) * BigInt(quote.segmentPrice)).toString(),
    "result_arithmetic_mismatch",
  );
  return reward;
}

export interface RewardPolicy {
  minRewardScoreBps: number;
  maxUnmeasuredBps: number;
}
export function qualifies(result: KaraokeResultBody, policy: RewardPolicy) {
  return (
    result.mode === "performance" &&
    result.rewardScoreBps !== null &&
    result.rewardScoreBps >= policy.minRewardScoreBps &&
    result.unmeasuredCount * 10000 <= policy.maxUnmeasuredBps * result.linesTotal
  );
}

export interface ReceiptLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  logIndex: Hex | number;
  transactionHash: Hex;
  blockNumber: Hex;
}
export interface Receipt {
  status: Hex | "success" | "reverted";
  transactionHash: Hex;
  blockNumber: Hex;
  logs: ReceiptLog[];
}
export const receiptSucceeded = (receipt: Receipt) =>
  receipt.status === "0x1" || receipt.status === "success";
