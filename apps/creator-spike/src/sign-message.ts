import { getAddress, isAddress } from "viem";
import { b64, sameBytes, unb64, utf8, walletOrigin } from "./shared.ts";

/** This pilot permits one independently reconstructed, non-transaction EIP-191 message. */
export function fixedSignMessage(id: string, address: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id) || !isAddress(address))
    throw new Error("Invalid fixed-signature intent.");
  const text = `Pirate creator test\nOrigin: ${walletOrigin}\nNetwork: Sui / Ika testnet\nWallet: ${getAddress(address)}\nChallenge: ${id}\nThis proves I reopened my creator wallet. It does not authorize a transfer.`;
  const encoded = utf8.encode(text);
  const prefix = utf8.encode(`\x19Ethereum Signed Message:\n${encoded.length}`);
  return b64(new Uint8Array([...prefix, ...encoded]));
}

/** Call before generating any Ika partial signature; never sign API-selected bytes. */
export function validateFixedSignMessage(
  id: string,
  address: string,
  supplied: string,
): Uint8Array {
  const expected = unb64(fixedSignMessage(id, address));
  if (!sameBytes(expected, unb64(supplied)))
    throw new Error(
      "The signing request is not the fixed reopen-wallet proof.",
    );
  return expected;
}
