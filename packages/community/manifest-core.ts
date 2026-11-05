import { CID } from "multiformats/cid";
import { type Address, type Hex, keccak256, encodeAbiParameters } from "viem";
import { amount, bytes32, exact, insist, object, text } from "./common.ts";

export const RELEASE_POLICY = "pirate-release/2026-08-29";
export const RELEASE_POLICY_HASH: Hex =
  "0xf4355daa134e09599937e0547188046289fc598c089bc2ac1d381fb327e64e84";
export function address(value: unknown, zero = false): Address {
  insist(
    typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value),
    "invalid_address",
  );
  insist(zero || !/^0x0+$/.test(value), "zero_address");
  return value as Address;
}
export function chain(value: unknown): 6343 | 31337 {
  insist(value === 6343 || value === 31337, "unsupported_publication_chain");
  return value;
}
export function decimal(value: unknown): string {
  const n = amount(value);
  insist(n < 2n ** 256n, "integer_overflow");
  return n.toString();
}
export function ipfsUri(value: unknown): string {
  const uri = text(value, 512);
  insist(
    uri.startsWith("ipfs://") && !/[/?#]/.test(uri.slice(7)),
    "invalid_ipfs_reference",
  );
  try {
    const cid = CID.parse(uri.slice(7));
    insist(
      cid.version === 1 &&
        (cid.code === 0x55 || cid.code === 0x70) &&
        cid.multihash.code === 0x12 &&
        cid.multihash.digest.length === 32,
      "unsupported_cid",
    );
    insist(uri === `ipfs://${cid.toString()}`, "noncanonical_cid");
  } catch {
    insist(false, "invalid_ipfs_reference");
  }
  return uri;
}
export function httpsOrigin(value: unknown): string {
  const origin = text(value, 512);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    insist(false, "invalid_origin");
  }
  insist(
    url.protocol === "https:" &&
      url.origin === origin &&
      !url.username &&
      !url.password,
    "invalid_origin",
  );
  return origin;
}
export function schema(value: unknown, name: string, keys: string[]) {
  const o = object(value);
  exact(o, ["schema", ...keys]);
  insist(o.schema === name, "unknown_schema");
  return o;
}
export interface PublicationIdentity {
  chainId: number;
  postsContract: Address;
  communityId: Hex;
  postId: Hex;
}
export function identity(o: Record<string, unknown>): PublicationIdentity {
  return {
    chainId: chain(o.chainId),
    postsContract: address(o.postsContract),
    communityId: bytes32(o.communityId),
    postId: bytes32(o.postId),
  };
}
export function communityId(chainId: number, registry: Address): Hex {
  chain(chainId);
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }],
      [BigInt(chainId), registry],
    ),
  );
}
