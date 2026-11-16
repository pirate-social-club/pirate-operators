import type { Address, Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import {
  consentAddress, consentDigest, parsePublicationGrant,
  parsePublicationWithdrawal, preparePublicationGrant,
  preparePublicationWithdrawal,
} from "../packages/protocol/publication-consent.ts";
import type {
  ConsentSourceV1, PreparedConsentCommandV1,
} from "../packages/protocol/publication-runtime-v1.ts";

export function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value),
    "publication_object_required");
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: string[]) {
  check(Object.keys(value).sort().join() === keys.slice().sort().join(),
    "publication_fields_invalid");
}
export function generation(value: unknown): number {
  check(typeof value === "string" && /^(0|[1-9][0-9]*)(?![\s\S])/.test(value),
    "publication_generation_invalid");
  const n = Number(value);
  check(Number.isSafeInteger(n) && n >= 0 && String(n) === value,
    "publication_generation_invalid");
  return n;
}
export function source(value: unknown): ConsentSourceV1 {
  const v = record(value);
  exact(v, ["schema", "resultsVersion", "chainId", "communityId",
    "installationId", "directory", "directoryRuntimeHash", "registry",
    "registryRuntimeHash", "releaseSelectionSha256"]);
  check(v.schema === "pirate.publication-source/1" && v.resultsVersion === 5 &&
    (v.chainId === 31337 || v.chainId === 6343) &&
    typeof v.installationId === "string" && /^[a-zA-Z0-9_-]{1,128}(?![\s\S])/.test(v.installationId),
    "publication_source_invalid");
  consentAddress(v.directory); consentAddress(v.registry);
  for (const k of ["communityId", "directoryRuntimeHash", "registryRuntimeHash",
    "releaseSelectionSha256"]) consentDigest(v[k]);
  return v as unknown as ConsentSourceV1;
}
export const sourceId = (s: ConsentSourceV1) => digest({
  schema: "pirate.publication-source-id/1", chainId: s.chainId,
  communityId: s.communityId, registry: s.registry,
  registryRuntimeHash: s.registryRuntimeHash,
});
export function commandId(c: {
  source: ConsentSourceV1; accountId: string; requestId: string;
  action: "grant" | "withdraw"; purpose: string;
}) {
  return digest({schema: "pirate.publication-action-id/1", accountId: c.accountId,
    communityId: c.source.communityId, sourceId: sourceId(c.source),
    purpose: c.purpose, action: c.action, requestId: c.requestId});
}
export function parseCommand(value: unknown): PreparedConsentCommandV1 {
  const v = record(value);
  exact(v, ["schema", "commandId", "requestId", "accountId", "source", "digest",
    "preparedAtMs", "localFenceGeneration", "action", "message"]);
  const s = source(v.source);
  check(v.schema === "pirate.publication-command/1" &&
    (v.action === "grant" || v.action === "withdraw") &&
    typeof v.accountId === "string" && /^[a-zA-Z0-9:_-]{1,160}(?![\s\S])/.test(v.accountId) &&
    typeof v.requestId === "string" && /^[a-zA-Z0-9:_-]{1,160}(?![\s\S])/.test(v.requestId) &&
    typeof v.preparedAtMs === "number" && Number.isSafeInteger(v.preparedAtMs) &&
    v.preparedAtMs > 0, "publication_command_invalid");
  generation(v.localFenceGeneration);
  const m = v.action === "grant" ? parsePublicationGrant(v.message)
    : parsePublicationWithdrawal(v.message);
  check(m.communityId === s.communityId, "publication_wrong_community");
  const id = commandId({source: s, accountId: v.accountId, requestId: v.requestId,
    action: v.action, purpose: m.purpose});
  const prepared = v.action === "grant"
    ? preparePublicationGrant(BigInt(s.chainId), s.registry, v.message, "0x")
    : preparePublicationWithdrawal(BigInt(s.chainId), s.registry, v.message, "0x");
  check(consentDigest(v.commandId) === id && consentDigest(v.digest) === prepared.digest,
    "publication_command_digest_changed");
  return v as unknown as PreparedConsentCommandV1;
}
export interface CapturedPublicationFeeV1 {
  schema: "pirate.publication-fee/1";
  chainId: 31337 | 6343;
  payer: Address;
  policyHash: Hex;
  cap: string;
  gas: string;
  gasPrice: string;
  dataFee: string;
}
export function capturedFee(value: unknown): CapturedPublicationFeeV1 {
  const v = record(value);
  exact(v, ["schema", "chainId", "payer", "policyHash", "cap", "gas", "gasPrice", "dataFee"]);
  check(v.schema === "pirate.publication-fee/1" &&
    (v.chainId === 31337 || v.chainId === 6343), "publication_fee_invalid");
  consentAddress(v.payer); consentDigest(v.policyHash);
  for (const k of ["cap", "gas", "gasPrice", "dataFee"])
    check(typeof v[k] === "string" && /^(0|[1-9][0-9]{0,77})(?![\s\S])/.test(v[k] as string),
      "publication_fee_invalid");
  const f = v as unknown as CapturedPublicationFeeV1;
  check([f.cap,f.gas,f.gasPrice,f.dataFee].every(n => BigInt(n) < (1n << 256n)),
    "publication_fee_invalid");
  check(BigInt(f.gas) > 0n && BigInt(f.gasPrice) > 0n &&
    BigInt(f.cap) >= BigInt(f.gas) * BigInt(f.gasPrice) + BigInt(f.dataFee),
    "publication_fee_invalid");
  return f;
}
export const feeLimits = (f: CapturedPublicationFeeV1) => ({
  cap: BigInt(f.cap), gas: BigInt(f.gas), gasPrice: BigInt(f.gasPrice),
  dataFee: BigInt(f.dataFee),
});
export function signature(value: unknown): Hex {
  check(typeof value === "string" && /^0x(?:[0-9a-f]{2})+(?![\s\S])/.test(value),
    "publication_signature_invalid");
  return value as Hex;
}
export function byteHex(value: unknown): Hex {
  check(typeof value === "string" && /^0x(?:[0-9a-f]{2})*(?![\s\S])/.test(value),
    "publication_bytes_invalid");
  return value as Hex;
}
export function preparedCall(c: PreparedConsentCommandV1, sig: Hex) {
  return c.action === "grant"
    ? preparePublicationGrant(BigInt(c.source.chainId), c.source.registry, c.message, sig)
    : preparePublicationWithdrawal(BigInt(c.source.chainId), c.source.registry, c.message, sig);
}
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export interface PublicationDispositionV1 {revision:number; hash:Hex}
/** Revision prevents ABA; the digest also catches any unversioned legacy
 * disposition mutation. Immutable raw transaction identity is checked apart. */
export function publicationDisposition(row: {
  publicationRevision?:number; mined:unknown; withheld?:unknown;
  cancellation?:unknown; publicationReceipt?:unknown; broadcast?:unknown;
}): PublicationDispositionV1 {
  const revision = row.publicationRevision ?? 0;
  check(Number.isSafeInteger(revision) && revision >= 0 && revision <= Number.MAX_SAFE_INTEGER,
    "publication_revision_invalid");
  return {revision,hash:digest({revision,mined:row.mined,withheld:row.withheld??null,
    cancellation:row.cancellation??null,receipt:row.publicationReceipt??null,
    broadcast:row.broadcast??null})};
}
