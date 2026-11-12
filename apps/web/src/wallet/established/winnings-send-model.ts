// Pure recipient policy from the pinned winnings-send-model; USDm token-name substitution only.
import { getAddress, isAddress, zeroAddress } from "viem";
export type RecipientCheck =
  | Readonly<{ ok: true; address: string }>
  | Readonly<{ ok: false; message: string }>;

/**
 * A 0x address with 40 hex digits. All-lowercase or all-uppercase hex carries
 * no checksum and is accepted; mixed case must match its EIP-55 checksum,
 * since a mismatch usually means a mistyped address. Never the sender itself
 * or the token contract.
 */
export function checkRecipient(
  input: string,
  sender: string,
  token: string,
): RecipientCheck {
  const value = input.trim();
  if (value.length === 0)
    return { ok: false, message: "Enter the address to send to." };
  if (
    !/^0x[0-9a-fA-F]{40}$/u.test(value) ||
    !isAddress(value, { strict: false })
  ) {
    return { ok: false, message: "Enter a valid address that starts with 0x." };
  }
  const digits = value.slice(2);
  const address = getAddress(value.toLowerCase());
  if (
    /[a-f]/u.test(digits) &&
    /[A-F]/u.test(digits) &&
    address !== `0x${digits}`
  ) {
    return {
      ok: false,
      message:
        "This address does not match its capital letters. Copy it again from where you found it.",
    };
  }
  if (address === zeroAddress)
    return { ok: false, message: "This address cannot receive USDm." };
  if (address === getAddress(sender.toLowerCase()))
    return {
      ok: false,
      message:
        "This is the wallet you are sending from. Enter a different address.",
    };
  if (address === getAddress(token.toLowerCase()))
    return {
      ok: false,
      message:
        "This is the USDm contract, not a wallet. Sending to it would lose the USDm.",
    };
  return { ok: true, address };
}
