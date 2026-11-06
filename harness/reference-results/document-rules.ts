// Independent public-document scalars and immutable wire-policy identifiers.
import { CID } from "multiformats/cid";
import { requireFact } from "./checks.ts";
export function exactDocument(value: any, fields: string[]) {
  requireFact(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...fields].sort().join(","),
    "unsupported_document_fields",
  );
}
export function documentText(value: unknown, maximum: number) {
  requireFact(
    typeof value === "string" &&
      value.length <= maximum &&
      !value.includes("\0"),
    "invalid_document_text",
  );
  return value;
}
export function documentInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  requireFact(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
    "invalid_document_integer",
  );
  return value;
}
export function documentHash(value: unknown) {
  requireFact(
    typeof value === "string" &&
      /^0x[0-9a-f]{64}$/.test(value) &&
      BigInt(value) > 0n,
    "invalid_document_hash",
  );
  return value;
}
export function documentAddress(value: unknown, zero = false) {
  requireFact(
    typeof value === "string" &&
      /^0x[0-9a-f]{40}$/.test(value) &&
      (zero || BigInt(value) > 0n),
    "invalid_document_address",
  );
  return value;
}
export function documentDecimal(value: unknown) {
  requireFact(
    typeof value === "string" &&
      /^(0|[1-9][0-9]{0,77})$/.test(value) &&
      BigInt(value) < 2n ** 256n,
    "invalid_document_decimal",
  );
  return value;
}
export function documentIpfs(value: unknown) {
  const uri = documentText(value, 512);
  requireFact(
    uri.startsWith("ipfs://") && !/[/?#]/.test(uri.slice(7)),
    "invalid_document_ipfs",
  );
  const cid = CID.parse(uri.slice(7));
  requireFact(
    cid.version === 1 &&
      [0x55, 0x70].includes(cid.code) &&
      cid.multihash.code === 0x12 &&
      cid.multihash.digest.length === 32 &&
      uri === "ipfs://" + cid.toString(),
    "invalid_document_ipfs",
  );
  return uri;
}
export function documentOrigin(value: unknown) {
  const origin = documentText(value, 512),
    parsed = new URL(origin);
  requireFact(
    parsed.protocol === "https:" &&
      parsed.origin === origin &&
      !parsed.username &&
      !parsed.password,
    "invalid_document_origin",
  );
  return origin;
}
export const admissionPolicies = {
  "pirate-release/2026-08-29":
    "0xf4355daa134e09599937e0547188046289fc598c089bc2ac1d381fb327e64e84",
  "pirate-owner-curated/2026-11-05/1":
    "0xeac6c5663b1942264851404e8a713b43eb222335338a8f68a2d09ad083b26d97",
} as const;
export function admissionPolicy(policy: any, curated?: boolean) {
  exactDocument(policy, ["version", "sha256"]);
  const version = policy.version as keyof typeof admissionPolicies;
  requireFact(
    Object.hasOwn(admissionPolicies, version) &&
      policy.sha256 === admissionPolicies[version] &&
      (curated === undefined ||
        version ===
          (curated
            ? "pirate-owner-curated/2026-11-05/1"
            : "pirate-release/2026-08-29")),
    "unsupported_admission_policy",
  );
}
