// Explicit public metadata only: no RPC URL, credential or private state path.
import type { ReferenceProfile, ContractProfile } from "./facts.ts";
import { requireFact } from "./checks.ts";
const keys = (value: any, required: string[], optional: string[] = []) => {
  requireFact(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
    "invalid_public_profile_fields",
  );
};
const address = (value: unknown) =>
  typeof value === "string" &&
  /^0x[0-9a-f]{40}$/i.test(value) &&
  BigInt(value) > 0n;
const digest = (value: unknown) =>
  typeof value === "string" &&
  /^0x[0-9a-f]{64}$/.test(value) &&
  BigInt(value) > 0n;
function contract(value: any, result = false): ContractProfile {
  keys(value, ["address", "fromBlock", "codeHash"], result ? ["version"] : []);
  requireFact(
    address(value.address) &&
      digest(value.codeHash) &&
      typeof value.fromBlock === "string" &&
      /^(0|[1-9][0-9]*)$/.test(value.fromBlock) &&
      (!result ||
        value.version === undefined ||
        value.version === 2 ||
        value.version === 3),
    "invalid_public_contract_profile",
  );
  return value;
}
export function referenceProfile(value: any): ReferenceProfile {
  keys(value, [
    "chainId",
    "communityId",
    "registry",
    "directory",
    "posts",
    "results",
  ]);
  requireFact(
    (value.chainId === 6343 || value.chainId === 31337) &&
      address(value.registry) &&
      digest(value.communityId) &&
      Array.isArray(value.results) &&
      value.results.length > 0 &&
      value.results.length <= 16,
    "invalid_public_profile",
  );
  contract(value.directory);
  contract(value.posts);
  value.results.forEach((row: any) => contract(row, true));
  requireFact(
    new Set(
      value.results.map((row: ContractProfile) => row.address.toLowerCase()),
    ).size === value.results.length,
    "duplicate_public_result_contract",
  );
  return value as ReferenceProfile;
}
