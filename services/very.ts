import { keccak256, encodeAbiParameters, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { attestationTypes, check } from "../packages/protocol/index.ts";
import { body, type Env, type Store, signatureChainId } from "./runtime.ts";

export async function attest(request: Request, env: Env, store: Store) {
  check(new URL(request.url).pathname === "/attest", "unknown_attester_method");
  const { pool, scope, claimant, subject } = await body<{
    pool: Address;
    scope: Hex;
    claimant: Address;
    subject: number;
  }>(request);
  check([1, 2, 3].includes(subject), "unknown_test_subject");
  const nullifier = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }],
      [BigInt(subject), scope],
    ),
  );
  const expiresAt = BigInt(store.now() + 600);
  const signature = await privateKeyToAccount(env.PRIVATE_KEY).signTypedData({
    domain: {
      name: "Pirate Reward Pool",
      version: "1",
      chainId: signatureChainId(env),
      verifyingContract: pool,
    },
    types: attestationTypes,
    primaryType: "RewardAttestation",
    message: { scope, nullifier, claimant, expiresAt },
  });
  return Response.json({
    nullifier,
    expiresAt: expiresAt.toString(),
    signature,
  });
}
