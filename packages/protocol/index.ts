import {
  sha256,
  stringToHex,
  verifyTypedData,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { KaraokeResultBody } from "./payments.ts";

export function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    check(Number.isFinite(value), "nonfinite_json");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  check(
    typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype,
    "invalid_json",
  );
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`)
    .join(",")}}`;
}
export const digest = (value: unknown): Hex =>
  sha256(stringToHex(canonical(value)));
/** Our contracts and payments run on local anvil and MegaETH testnet only. */
export const SUPPORTED_CHAINS = [31337, 6343] as const;
export function supportedChain(chainId: number) {
  check(
    (SUPPORTED_CHAINS as readonly number[]).includes(chainId),
    "unsupported_chain",
  );
  return chainId;
}
export const domain = {
  name: "PirateOperatorsLocal",
  version: "0",
  chainId: 31337,
} as const;
const types = {
  Envelope: [
    { name: "kind", type: "string" },
    { name: "bodyHash", type: "bytes32" },
  ],
} as const;
export interface Signed<T> {
  kind: string;
  body: T;
  signer: Address;
  signature: Hex;
}
export async function sign<T>(
  kind: string,
  body: T,
  key: Hex,
  chainId: number = domain.chainId,
): Promise<Signed<T>> {
  const account = privateKeyToAccount(key);
  const signature = await account.signTypedData({
    domain: { ...domain, chainId },
    types,
    primaryType: "Envelope",
    message: { kind, bodyHash: digest(body) },
  });
  return { kind, body, signer: account.address, signature };
}
export async function verify<T>(
  record: Signed<T>,
  kind: string,
  signer: Address,
  chainId: number = domain.chainId,
): Promise<T> {
  check(
    record.kind === kind &&
      record.signer.toLowerCase() === signer.toLowerCase(),
    "untrusted_signer",
  );
  check(
    await verifyTypedData({
      address: signer,
      domain: { ...domain, chainId },
      types,
      primaryType: "Envelope",
      message: { kind, bodyHash: digest(record.body) },
      signature: record.signature,
    }),
    "bad_signature",
  );
  return record.body;
}
export interface Song {
  communityId: string;
  audio: string;
  title: string;
  lyrics: string;
  artwork: string;
  original: boolean;
}
export const inputHashes = (song: Song) => ({
  audio: sha256(song.audio as Hex),
  title: sha256(stringToHex(song.title)),
  lyrics: sha256(stringToHex(song.lyrics)),
  artwork: sha256(stringToHex(song.artwork)),
});
export interface Evidence {
  communityId: string;
  check: string;
  inputHash: Hex;
  outcome: string;
  expiresAt: number;
}
export function gate(
  song: Song,
  records: Evidence[],
  now: number,
): "published" | "hold" | "blocked" {
  const hashes = inputHashes(song);
  for (const [input, hash] of Object.entries(hashes))
    check(
      records.some(
        (r) =>
          r.check === input &&
          r.communityId === song.communityId &&
          r.inputHash === hash &&
          r.expiresAt > now,
      ),
      "missing_current_evidence",
    );
  const audio = records.find((r) => r.check === "audio")!;
  if (audio.outcome === "match") return "blocked";
  return audio.outcome === "no_match" && song.original ? "published" : "hold";
}
/**
 * Karaoke attempt ticket. Payment terms come from the pinned operator quote
 * (docs/operator-payments.md section 5.2), so the ticket carries no ceiling.
 */
export interface Ticket {
  ticketId: Hex;
  communityId: string;
  participant: Address;
  songHash: Hex;
  manifestSha256: Hex;
  sessionKey: Address;
  operator: Address;
  quoteId: Hex;
  /** The community's address in OperatorPayments. */
  community: Address;
  mode: "performance";
  maxPaidSegments: number;
  maxDurationMs: number;
  issuedAt: number;
  expiresAt: number;
  /**
   * V4 only: the learner's sign-in authorization the run is published under.
   * V2 and V3 tickets never carry this field, so their bytes are unchanged.
   */
  authorizationId?: Hex;
}
export interface Summary {
  scoreBps: number;
  coverageBps: number;
  scoringVersion: number;
}
export type Result = KaraokeResultBody;
export const attestationTypes = {
  RewardAttestation: [
    { name: "scope", type: "bytes32" },
    { name: "nullifier", type: "bytes32" },
    { name: "claimant", type: "address" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const registrationTypes = {
  Registration: [
    { name: "scope", type: "bytes32" },
    { name: "claimant", type: "address" },
    { name: "recipient", type: "address" },
    { name: "attemptId", type: "bytes32" },
    { name: "nullifier", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;
