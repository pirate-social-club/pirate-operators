import { hexToBytes, keccak256, sha256, toHex, type Hex } from "viem";
import type { ContractProfile, RawLog, ReferenceSnapshot } from "./facts.ts";

export function requireFact(value: unknown, problem: string): asserts value {
  if (!value) throw Error(`reference_${problem}`);
}
export const lower = (value: string) => value.toLowerCase();
export const zero = `0x${"0".repeat(64)}` as Hex;
export function integer(value: bigint | string | number) {
  const n = Number(value);
  requireFact(Number.isSafeInteger(n) && n >= 0, "unsafe_integer");
  return n;
}
export function learningDay(timestamp: bigint | string | number) {
  const n = integer(timestamp);
  requireFact(n >= 1793552400, "before_learning_epoch");
  return Math.floor((n - 1793552400) / 86400);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    requireFact(Number.isFinite(value), "invalid_number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        requireFact(next >= 0xdc00 && next <= 0xdfff, "invalid_unicode");
      } else requireFact(c < 0xdc00 || c > 0xdfff, "invalid_unicode");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  requireFact(
    value &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype,
    "invalid_json",
  );
  return `{${Object.keys(value)
    .sort()
    .map(
      (k) =>
        `${canonical(k)}:${canonical((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}
export function publicDocument(
  snapshot: ReferenceSnapshot,
  uri: string,
  hash: Hex,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const wire = snapshot.documents[uri];
  requireFact(
    wire && wire.length <= 2 + maximum * 2 && sha256(wire) === hash,
    "document_unavailable_or_changed",
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    hexToBytes(wire),
  );
  const value = JSON.parse(text);
  requireFact(
    text === canonical(value) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value),
    "noncanonical_document",
  );
  return value as Record<string, any>;
}
export function rawCode(snapshot: ReferenceSnapshot, profile: ContractProfile) {
  const code = snapshot.codes[lower(profile.address)];
  requireFact(
    code && keccak256(code) === profile.codeHash,
    "contract_code_changed",
  );
}
export function rawEvent(snapshot: ReferenceSnapshot, log: RawLog) {
  requireFact(
    !log.removed && BigInt(log.blockNumber) <= BigInt(snapshot.head.number),
    "orphan_or_future_log",
  );
  const header = snapshot.blocks[log.blockNumber],
    receipt = snapshot.receipts[log.transactionHash];
  requireFact(
    Number.isSafeInteger(log.transactionIndex) &&
      log.transactionIndex >= 0 &&
      Number.isSafeInteger(log.logIndex) &&
      log.logIndex >= 0 &&
      header?.number === log.blockNumber &&
      header.hash === log.blockHash &&
      receipt?.status === "success" &&
      receipt.hash === log.transactionHash &&
      receipt.blockHash === log.blockHash &&
      receipt.blockNumber === log.blockNumber,
    "noncanonical_event",
  );
  requireFact(
    receipt.logs.some(
      (x) =>
        x.address.toLowerCase() === log.address.toLowerCase() &&
        x.logIndex === log.logIndex &&
        x.transactionIndex === log.transactionIndex &&
        x.transactionHash === log.transactionHash &&
        x.blockNumber === log.blockNumber &&
        x.blockHash === log.blockHash &&
        !x.removed &&
        x.data === log.data &&
        canonical(x.topics) === canonical(log.topics),
    ),
    "receipt_log_mismatch",
  );
  return header;
}
export function ordered(snapshot: ReferenceSnapshot, address: string) {
  return snapshot.logs
    .filter((x) => lower(x.address) === lower(address))
    .sort((a, b) =>
      BigInt(a.blockNumber) < BigInt(b.blockNumber)
        ? -1
        : BigInt(a.blockNumber) > BigInt(b.blockNumber)
          ? 1
          : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex,
    );
}
export const documentHex = (value: unknown) => toHex(canonical(value));
