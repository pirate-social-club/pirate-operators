// Learner accounts that sign with code (docs/learning-records-contract.md
// section 9). A MOSS account that has never transacted has no code yet, so
// its signatures arrive ERC-8010-wrapped: the learner's own EIP-7702
// authorization, the call that sets the account up, and the inner signature
// the account checks once it exists. The operator activates such an account
// before opening the attempt, and asks the account itself, through ERC-1271,
// whether it accepts the consent.
import {
  decodeFunctionResult,
  encodeFunctionData,
  isErc8010Signature,
  parseAbi,
  parseErc8010Signature,
  type Address,
  type Hex,
} from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { check } from "../packages/protocol/index.ts";
import { latestNonce, rpc } from "./chain.ts";
import type { StoredAuthorization } from "./operator-tx.ts";
import type { Env } from "./runtime.ts";

export interface Activation {
  authorization: StoredAuthorization;
  initializer: Address;
  data: Hex;
  /** The signature the activated account checks. */
  inner: Hex;
}
const ERC1271_MAGIC = "0x1626ba7e";
const erc1271Abi = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The parts of an ERC-8010 signature that carry an activation, or nothing for any other signature. */
export function activationOf(signature: Hex): Activation | undefined {
  if (!isErc8010Signature(signature)) return undefined;
  const wrapped = parseErc8010Signature(signature);
  if (!("authorization" in wrapped) || !wrapped.authorization || !wrapped.address || !wrapped.data) return undefined;
  const a = wrapped.authorization;
  return {
    authorization: { address: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity ?? 0 },
    initializer: wrapped.address,
    data: wrapped.data,
    inner: wrapped.signature,
  };
}

/** The EIP-7702 designator an account carries once delegated to `delegate`. */
export const designatorOf = (delegate: Address) => `0xef0100${delegate.slice(2)}`.toLowerCase();

/**
 * The activation belongs to the learner and uses only the approved delegate
 * and initializer. Its chain ID is 0 (valid on every chain that accepts it)
 * or the records chain; either way the operator sends it only to that chain.
 */
export async function checkActivation(env: Env, learner: Address, activation: Activation, chainId: number) {
  check(env.ACCOUNT_DELEGATE && env.ACCOUNT_INITIALIZER, "activation_unconfigured");
  const authority = await recoverAuthorizationAddress({ authorization: activation.authorization }).catch(() => undefined);
  check(same(authority, learner), "authorization_not_learners");
  check(same(activation.authorization.address, env.ACCOUNT_DELEGATE), "unapproved_delegate");
  check(same(activation.initializer, env.ACCOUNT_INITIALIZER), "unapproved_initializer");
  check(activation.authorization.chainId === 0 || activation.authorization.chainId === chainId, "authorization_wrong_chain");
}

export const codeOf = async (env: Env, account: Address) =>
  ((await rpc<Hex>(env.RPC_URL, "eth_getCode", [account, "latest"])) ?? "0x").toLowerCase() as Hex;
export const nonceOf = (env: Env, account: Address) => latestNonce(env.RPC_URL, account);

/** ERC-1271 on the account as it stands on chain now; false for any revert or other answer. */
export async function acceptedByAccount(env: Env, account: Address, digest: Hex, signature: Hex) {
  const result = await rpc<Hex>(env.RPC_URL, "eth_call", [
    { to: account, data: encodeFunctionData({ abi: erc1271Abi, functionName: "isValidSignature", args: [digest, signature] }) },
    "latest",
  ]).catch(() => undefined);
  if (!result || result === "0x") return false;
  try {
    return decodeFunctionResult({ abi: erc1271Abi, functionName: "isValidSignature", data: result }) === ERC1271_MAGIC;
  } catch {
    return false;
  }
}
