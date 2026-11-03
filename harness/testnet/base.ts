import { createWalletClient, parseEther, keccak256, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { compile } from "../compile.ts";
import { check } from "../../packages/protocol/index.ts";
import { publicNetworks, networks, rejectFixtureKeys } from "./config.ts";
import type { PoolChain } from "../flow.ts";

export async function baseChain(
  keys: readonly Hex[],
  record: (event: unknown) => void,
): Promise<PoolChain> {
  rejectFixtureKeys(keys);
  const { base } = await publicNetworks();
  const accounts = keys.map((key) => privateKeyToAccount(key));
  const clients = accounts.map((account) =>
    createWalletClient({
      chain: baseSepolia,
      account,
      transport: http(networks.base.rpc, { timeout: 15000, retryCount: 1 }),
    }),
  );
  const balance = await base.getBalance({ address: accounts[0].address });
  check(balance >= parseEther("0.001"), "base_sponsor_needs_test_eth");
  const artifacts = compile();
  let executionFees = 0n;
  const receipt = async (hash: Hex, kind: string) => {
    const result = await base.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 120000,
    });
    check(result.status === "success", `base_transaction_reverted:${kind}`);
    executionFees += result.gasUsed * result.effectiveGasPrice;
    record({
      kind,
      chainId: 84532,
      transactionHash: hash,
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      gasUsed: result.gasUsed,
      effectiveGasPrice: result.effectiveGasPrice,
      l1Fee: result.l1Fee ?? null,
      executionFeeWei: result.gasUsed * result.effectiveGasPrice,
    });
    check(
      executionFees < parseEther("0.005"),
      "base_execution_fee_budget_reached",
    );
    return result;
  };
  // Ordinary claims for this spike: provision participants and executor with
  // test ETH. This does not establish sponsored production transactions.
  for (const i of [1, 5, 6, 7, 8]) {
    const current = await base.getBalance({ address: accounts[i].address });
    const target = parseEther("0.00005");
    if (current < target)
      await receipt(
        await clients[0].sendTransaction({
          to: accounts[i].address,
          value: target - current,
        }),
        "gas_topup",
      );
  }
  const deploy = async (name: string, args: readonly unknown[]) => {
    const result = await receipt(
      await clients[0].deployContract({ ...artifacts[name], args }),
      `deploy:${name}`,
    );
    check(result.contractAddress, "deployment_address_missing");
    const code = await base.getCode({ address: result.contractAddress });
    check(code && code !== "0x", "deployment_code_missing");
    record({
      kind: "contract",
      name,
      chainId: 84532,
      address: result.contractAddress,
      codeHash: keccak256(code),
    });
    return result.contractAddress;
  };
  const write = async (
    address: Address,
    name: string,
    functionName: string,
    args: readonly unknown[] = [],
    signer = 0,
  ) => {
    check([0, 1, 5, 6, 7, 8].includes(signer), "unexpected_base_signer");
    return receipt(
      await clients[signer].writeContract({
        address,
        abi: artifacts[name].abi,
        functionName,
        args,
      }),
      functionName,
    );
  };
  const read = (
    address: Address,
    name: string,
    functionName: string,
    args: readonly unknown[] = [],
  ) =>
    base.readContract({
      address,
      abi: artifacts[name].abi,
      functionName,
      args,
    });
  const token = await deploy("TestUSDC", []);
  const jackpot = await deploy("MockJackpot", [token]);
  return {
    token,
    jackpot,
    deploy,
    write,
    read,
    timestamp: async () => Number((await base.getBlock()).timestamp),
    advanceTo: async (target) => {
      const deadline = Date.now() + 360000;
      let nextNotice = 0;
      while (Number((await base.getBlock()).timestamp) < target) {
        check(Date.now() < deadline, "base_deadline_wait_timeout");
        if (Date.now() >= nextNotice) {
          record({ kind: "waiting_for_chain_time", chainId: 84532, target });
          nextNotice = Date.now() + 15000;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    },
  };
}
