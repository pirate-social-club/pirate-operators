/** A wallet-reported hash is only a candidate. Canonical server reconciliation alone confirms payment. */
export type RewardTransactionOutcome =
  | "approved"
  | "cancelled"
  | "error"
  | "unknown";
export interface RewardTransactionCandidate {
  outcome: RewardTransactionOutcome;
  disposition: "candidate" | "no_candidate" | "rejected";
  reason:
    | "unique_hash"
    | "missing_hash"
    | "testnet_context_required"
    | "malformed_result"
    | "malformed_receipt"
    | "malformed_chain"
    | "wrong_chain"
    | "malformed_hash"
    | "conflicting_hashes";
  hash?: string;
  chainEvidence?: "explicit_testnet" | "verified_testnet_context";
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, "value"))
    throw Error("accessor_field");
  return descriptor?.value;
}
function chain(value: unknown): "missing" | "expected" | "wrong" | "malformed" {
  if (value === undefined) return "missing";
  let number: bigint;
  if (typeof value === "bigint") number = value;
  else if (typeof value === "number" && Number.isSafeInteger(value))
    number = BigInt(value);
  else if (
    typeof value === "string" &&
    value.length <= 66 &&
    /^(?:0|[1-9][0-9]*|0x[0-9a-f]+)$/i.test(value)
  )
    number = BigInt(value);
  else return "malformed";
  if (number < 0n || number >= 2n ** 256n) return "malformed";
  return number === 6343n ? "expected" : "wrong";
}
const rejected = (
  reason: RewardTransactionCandidate["reason"],
): RewardTransactionCandidate => ({
  outcome: "unknown",
  disposition: "rejected",
  reason,
});
/** Call only after the SDK is on testnet and its connected address matched the prepared sender. */
export function parseRewardTransactionResult(
  value: unknown,
  context: { network: unknown; expectedAccountVerified: boolean },
): RewardTransactionCandidate {
  if (
    context?.network !== "testnet" ||
    context.expectedAccountVerified !== true
  )
    return rejected("testnet_context_required");
  try {
    if (!object(value)) return rejected("malformed_result");
    const resultChain = chain(field(value, "chainId"));
    if (resultChain === "wrong") return rejected("wrong_chain");
    if (resultChain === "malformed") return rejected("malformed_chain");
    const rawStatus = field(value, "status");
    const outcome: RewardTransactionOutcome =
      rawStatus === "approved" ||
      rawStatus === "cancelled" ||
      rawStatus === "error"
        ? rawStatus
        : "unknown";
    const singular = field(value, "receipt"),
      plural = field(value, "receipts");
    if (singular !== undefined && !object(singular))
      return rejected("malformed_receipt");
    if (plural !== undefined && (!Array.isArray(plural) || plural.length > 32))
      return rejected("malformed_receipt");
    const receipts: unknown[] = [
      ...(singular === undefined ? [] : [singular]),
      ...(plural === undefined ? [] : (plural as unknown[])),
    ];
    const hashes = new Set<string>();
    let contextOnly = false;
    for (const receipt of receipts) {
      if (!object(receipt)) return rejected("malformed_receipt");
      const receiptChain = chain(field(receipt, "chainId"));
      if (receiptChain === "wrong") return rejected("wrong_chain");
      if (receiptChain === "malformed") return rejected("malformed_chain");
      for (const key of ["transactionHash", "hash"]) {
        const raw = field(receipt, key);
        if (raw === undefined) continue;
        if (typeof raw !== "string" || !/^0x[0-9a-f]{64}$/i.test(raw))
          return rejected("malformed_hash");
        hashes.add(raw.toLowerCase());
        if (receiptChain === "missing") contextOnly = true;
      }
    }
    if (hashes.size > 1) return rejected("conflicting_hashes");
    if (hashes.size === 0)
      return {
        outcome: outcome === "approved" ? "unknown" : outcome,
        disposition: "no_candidate",
        reason: "missing_hash",
      };
    return {
      outcome,
      disposition: "candidate",
      reason: "unique_hash",
      hash: [...hashes][0],
      chainEvidence: contextOnly
        ? "verified_testnet_context"
        : "explicit_testnet",
    };
  } catch {
    // Accessors, proxies and other malformed objects must never expose a raw error or partial candidate.
    return rejected("malformed_result");
  }
}
