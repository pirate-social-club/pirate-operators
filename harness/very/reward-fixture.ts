import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { digest, registrationTypes } from "../../packages/protocol/index.ts";
import type { PoolChain } from "../flow.ts";
import type { Permit } from "../../services/very-attester/policy.ts";

export interface PreparedReward {
  chainId: 31337 | 84532;
  pool: Address;
  attemptId: Hex;
  claimant: Address;
  scope: Hex;
  deadline: number;
}
// A synthetic qualification isolates credential-to-contract integration. This
// is not a real karaoke attempt, Megapot drawing or USDC deposit.
export async function prepareReward(
  evm: PoolChain,
  accounts: readonly PrivateKeyAccount[],
  chainId: 31337 | 84532,
  window = 0,
): Promise<PreparedReward> {
  const cutoff = (await evm.timestamp()) + 120;
  const policy = digest({ policy: "very-attester-synthetic-entry/1" });
  const attemptId = digest({ attempt: "synthetic-very-integration/1" });
  const claimant = accounts[5].address;
  const pool = await evm.deploy("RewardPool", [
    evm.token,
    evm.jackpot,
    accounts[8].address,
    accounts[1].address,
    accounts[4].address,
    1n,
    BigInt(cutoff),
    BigInt(window),
    1n,
    1000000n,
    policy,
  ]);
  await evm.write(evm.token, "TestUSDC", "mint", [pool, 1000000n]);
  const root = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
      ],
      [pool, 1n, claimant, attemptId],
    ),
  );
  await evm.write(pool, "RewardPool", "commitEntries", [root, 1n, policy], 1);
  await evm.write(
    pool,
    "RewardPool",
    "purchase",
    [[{ normals: [1, 2, 3, 4, 5], bonusball: 1 }]],
    8,
  );
  await evm.advanceTo(cutoff);
  await evm.write(evm.jackpot, "MockJackpot", "draw", [1n, 10000001n]);
  await evm.write(pool, "RewardPool", "settle");
  return {
    chainId,
    pool,
    attemptId,
    claimant,
    scope: (await evm.read(pool, "RewardPool", "scope")) as Hex,
    deadline: Number(await evm.read(pool, "RewardPool", "deadline")),
  };
}
export async function registerReward(
  evm: Pick<PoolChain, "read" | "write">,
  reward: PreparedReward,
  account: PrivateKeyAccount,
  permit: Permit,
) {
  if (
    await evm.read(reward.pool, "RewardPool", "registered", [reward.claimant])
  )
    return;
  if (account.address !== reward.claimant)
    throw new Error("unexpected_claimant");
  const message = {
    scope: reward.scope,
    claimant: reward.claimant,
    recipient: reward.claimant,
    attemptId: reward.attemptId,
    nullifier: permit.nullifier,
    expiresAt: BigInt(permit.expiresAt),
  };
  const authorization = await account.signTypedData({
    domain: {
      name: "Pirate Reward Pool",
      version: "1",
      chainId: reward.chainId,
      verifyingContract: reward.pool,
    },
    types: registrationTypes,
    primaryType: "Registration",
    message,
  });
  await evm.write(
    reward.pool,
    "RewardPool",
    "registerFor",
    [{ ...message, proof: [], authorization, attestation: permit.signature }],
    1,
  );
  if ((await evm.read(reward.pool, "RewardPool", "registeredCount")) !== 1n)
    throw new Error("registration_not_observed");
}
