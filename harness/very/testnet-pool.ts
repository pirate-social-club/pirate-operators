import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  keccak256,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { compile } from "../compile.ts";
import {
  assertNetwork,
  networks,
  rejectFixtureKeys,
} from "../testnet/config.ts";
import { check } from "../../packages/protocol/index.ts";
import type { PoolChain } from "../flow.ts";
import type { AttesterConfig } from "../../services/very-attester/policy.ts";

export async function testnetPool(
  config: AttesterConfig,
  keys: readonly Hex[],
  record: (event: unknown) => void,
): Promise<Pick<PoolChain, "read" | "write">> {
  rejectFixtureKeys(keys);
  check(config.chainId === 84532, "base_sepolia_required");
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(networks.base.rpc, { timeout: 15000, retryCount: 0 }),
  });
  await assertNetwork(() => client.getChainId(), 84532);
  const code = await client.getCode({ address: config.pool });
  check(code && keccak256(code) === config.poolCodeHash, "pool_code_mismatch");
  const abi = compile().RewardPool.abi;
  const relayer = createWalletClient({
    account: privateKeyToAccount(keys[1]),
    chain: baseSepolia,
    transport: http(networks.base.rpc, { timeout: 15000, retryCount: 0 }),
  });
  let submitted = false;
  return {
    read: async (address, name, functionName, args = []) => {
      check(
        address.toLowerCase() === config.pool.toLowerCase() &&
          name === "RewardPool",
        "unexpected_contract",
      );
      return client.readContract({ address, abi, functionName, args });
    },
    write: async (address, name, functionName, args = [], signer = 0) => {
      check(
        !submitted &&
          address.toLowerCase() === config.pool.toLowerCase() &&
          name === "RewardPool" &&
          functionName === "registerFor" &&
          signer === 1,
        "unexpected_registration_write",
      );
      await assertNetwork(() => client.getChainId(), 84532);
      const estimated = await client.estimateContractGas({
        account: relayer.account,
        address,
        abi,
        functionName,
        args,
      });
      const gas = (estimated * 120n) / 100n;
      const gasPrice = await client.getGasPrice();
      check(
        gas <= 350000n && gas * gasPrice < parseEther("0.00005"),
        "registration_gas_cap",
      );
      // Unknown send outcomes are reconciled by reads, never auto-resubmitted.
      submitted = true;
      const hash = await relayer.writeContract({
        address,
        abi,
        functionName,
        args,
        gas,
        gasPrice,
      });
      record({
        kind: "registration_submitted",
        chainId: 84532,
        transactionHash: hash,
      });
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120000,
      });
      check(receipt.status === "success", "registration_reverted");
      record({
        kind: "registration_confirmed",
        chainId: 84532,
        transactionHash: hash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
      });
      return receipt;
    },
  };
}
