import { encodeAbiParameters, keccak256, parseAbi, type Hex } from "viem";
export const MOSS_GUARD_PROXY = "0xf655611abe392f35cbb36181d920a302c4df2284";
export const MOSS_GUARD_PROXY_HASH =
  "0xa9e8dc499fc1935a3e282246159972f7a6913d6dfbb7f47ea03dfd7e1ea227f5";
export const MOSS_GUARD_IMPLEMENTATION =
  "0x6a5bafc2bf124d9442f3187022c85e4d3ef920dd";
export const MOSS_GUARD_IMPLEMENTATION_HASH =
  "0x4719607f0c71dddc599099914a4cc35be615f364926438caf3b634a3e7e17895";
export const MOSS_GUARD_ORCHESTRATOR =
  "0xdb03009c44a36a7490d80c9a9e1a03b53497dc42";
export const mossGuardAbi = parseAbi([
  "function getNonce(uint192) view returns(uint256)",
  "function accountImplementationOf(address) view returns(address)",
  "event NonceInvalidated(uint256 nonce)",
]);
/** Separate from MOSS's ordinary and executeAs nonce sequences; fixed for the logical payment. */
export function paymentGuardNonce(
  programId: string,
  sender: string,
  paymentId: string,
) {
  const hash = keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "bytes32" },
        { type: "address" },
        { type: "string" },
      ],
      [
        "pirate-reward-payment-guard/1",
        programId as Hex,
        sender as Hex,
        paymentId,
      ],
    ),
  );
  return (
    ((0x5052n << 176n) | (BigInt(hash) & ((1n << 176n) - 1n))) <<
    64n
  ).toString();
}
