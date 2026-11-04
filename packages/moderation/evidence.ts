import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  object,
  text,
} from "../community/common.ts";
import { address, RELEASE_POLICY } from "../community/manifest-core.ts";

export const evidenceDomain = {
  name: "Pirate Operators",
  version: "1",
} as const;
export const evidenceTypes = {
  Evidence: [
    { name: "check", type: "string" },
    { name: "schema", type: "string" },
    { name: "submissionId", type: "string" },
    { name: "communityId", type: "string" },
    { name: "jobId", type: "string" },
    { name: "subject", type: "bytes32" },
    { name: "inputsHash", type: "bytes32" },
    { name: "evaluator", type: "string" },
    { name: "policy", type: "string" },
    { name: "result", type: "string" },
    { name: "detailsHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "operator", type: "address" },
  ],
} as const;
export const evidenceSchemas = {
  "audio.identification": "pirate.evidence.audio-identification/1",
  "title.rating": "pirate.evidence.title-rating/1",
  "lyrics.classification": "pirate.evidence.lyrics-classification/1",
  "artwork.display": "pirate.evidence.artwork-display/1",
} as const;
export type EvidenceCheck = keyof typeof evidenceSchemas;
export interface Evidence {
  check: EvidenceCheck;
  schema: string;
  submissionId: string;
  communityId: string;
  jobId: string;
  subject: Hex;
  inputsHash: Hex;
  evaluator: string;
  policy: string;
  result: string;
  detailsHash: Hex;
  issuedAt: number;
  expiresAt: number;
  operator: Address;
}
export interface EvidenceRecord {
  envelope: Evidence;
  inputs: Record<string, unknown>;
  details: Record<string, unknown>;
  signature: Hex;
}
const message = (e: Evidence) => ({
  ...e,
  issuedAt: BigInt(e.issuedAt),
  expiresAt: BigInt(e.expiresAt),
});
export const evidenceId = (e: Evidence) =>
  hashTypedData({
    domain: evidenceDomain,
    types: evidenceTypes,
    primaryType: "Evidence",
    message: message(e),
  });
export function validateEvidence(value: unknown): EvidenceRecord {
  const record = object(value);
  exact(record, ["envelope", "inputs", "details", "signature"]);
  const e = object(record.envelope);
  exact(
    e,
    evidenceTypes.Evidence.map((field) => field.name),
  );
  const check = text(e.check, 64) as EvidenceCheck;
  insist(
    Object.hasOwn(evidenceSchemas, check) &&
      e.schema === evidenceSchemas[check] &&
      e.policy === RELEASE_POLICY,
    "unsupported_evidence",
  );
  const envelope: Evidence = {
    check,
    schema: text(e.schema, 128),
    submissionId: text(e.submissionId, 128),
    communityId: bytes32(e.communityId),
    jobId: text(e.jobId, 128),
    subject: bytes32(e.subject),
    inputsHash: bytes32(e.inputsHash),
    evaluator: text(e.evaluator, 256),
    policy: RELEASE_POLICY,
    result: text(e.result, 64),
    detailsHash: bytes32(e.detailsHash),
    issuedAt: integer(e.issuedAt, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(e.expiresAt, 1, Number.MAX_SAFE_INTEGER),
    operator: address(e.operator),
  };
  insist(
    envelope.submissionId.length > 0 &&
      envelope.jobId.length > 0 &&
      envelope.evaluator.length > 0 &&
      envelope.expiresAt > envelope.issuedAt,
    "invalid_evidence_interval",
  );
  const inputs = object(record.inputs),
    details = object(record.details);
  insist(
    hashJson(inputs) === envelope.inputsHash &&
      hashJson(details) === envelope.detailsHash,
    "evidence_body_hash_mismatch",
  );
  insist(
    typeof record.signature === "string" &&
      /^0x[0-9a-f]{130}$/.test(record.signature),
    "invalid_evidence_signature",
  );
  return { envelope, inputs, details, signature: record.signature as Hex };
}
export async function signEvidence(
  account: PrivateKeyAccount,
  envelope: Omit<Evidence, "operator" | "inputsHash" | "detailsHash">,
  inputs: Record<string, unknown>,
  details: Record<string, unknown>,
): Promise<EvidenceRecord> {
  const e: Evidence = {
    ...envelope,
    operator: account.address.toLowerCase() as Address,
    inputsHash: hashJson(inputs),
    detailsHash: hashJson(details),
  };
  const signature = await account.signTypedData({
    domain: evidenceDomain,
    types: evidenceTypes,
    primaryType: "Evidence",
    message: message(e),
  });
  return validateEvidence({ envelope: e, inputs, details, signature });
}
export async function recoverEvidence(record: EvidenceRecord) {
  return (
    await recoverTypedDataAddress({
      domain: evidenceDomain,
      types: evidenceTypes,
      primaryType: "Evidence",
      message: message(record.envelope),
      signature: record.signature,
    })
  ).toLowerCase();
}
