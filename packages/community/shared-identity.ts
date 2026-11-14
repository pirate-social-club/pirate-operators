import { encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";
import { insist } from "./common.ts";
import { chain } from "./manifest-core.ts";

// End-of-input assertions deliberately reject LF, CRLF and Unicode terminators.
export function sharedBytes32(value: unknown): Hex {
  insist(typeof value === "string" && /^0x[0-9a-f]{64}(?![\s\S])/.test(value) &&
    value !== "0x" + "0".repeat(64), "invalid_shared_bytes32");
  return value as Hex;
}
export function canonicalTld(value: unknown): string {
  insist(typeof value === "string" && value.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?![\s\S])/.test(value) &&
    !(value[2] === "-" && value[3] === "-"), "invalid_shared_tld");
  return value;
}
export function directoryInstanceId(chainId: number, communityKey: Hex): Hex {
  chain(chainId);
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [keccak256(stringToHex("pirate.community/2")), BigInt(chainId), sharedBytes32(communityKey)],
  ));
}
export function sharedNamespaceId(tld: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }],
    [keccak256(stringToHex("pirate.namespace/1")), keccak256(stringToHex(canonicalTld(tld)))]));
}
