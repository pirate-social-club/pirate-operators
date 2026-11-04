import { spawn } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { foundry } from "viem/chains";
import { accounts } from "./runtime.ts";
import { compile } from "./compile.ts";

export async function chain(port = 18545) {
  const child = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      "31337",
      "--timestamp",
      "1800000000",
      "--block-base-fee-per-gas",
      "0",
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const transport = http(`http://127.0.0.1:${port}`);
  const publicClient = createPublicClient({ chain: foundry, transport });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`anvil exited: ${stderr}`);
      try {
        await publicClient.getChainId();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (!ready) throw new Error("anvil_not_ready");
    const rpc = async (method: string, params: unknown[]) => {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const value = (await response.json()) as {
        result?: unknown;
        error?: unknown;
      };
      if (value.error) throw new Error(JSON.stringify(value.error));
      return value.result;
    };
    for (const account of accounts)
      await rpc("anvil_setBalance", [account.address, "0x3635c9adc5dea00000"]);
    const artifacts = compile();
    const clients = accounts.map((account) =>
      createWalletClient({ chain: foundry, transport, account }),
    );
    const deploy = async (name: string, args: readonly unknown[]) => {
      const hash = await clients[0].deployContract({
        ...artifacts[name],
        args,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress || receipt.status !== "success")
        throw new Error(`deploy_failed:${name}`);
      return receipt.contractAddress;
    };
    const write = async (
      address: Address,
      name: string,
      functionName: string,
      args: readonly unknown[] = [],
      signer = 0,
    ) => {
      const hash = await clients[signer].writeContract({
        address,
        abi: artifacts[name].abi,
        functionName,
        args,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new Error(`transaction_reverted:${functionName}`);
      return receipt;
    };
    const read = (
      address: Address,
      name: string,
      functionName: string,
      args: readonly unknown[] = [],
    ) =>
      publicClient.readContract({
        address,
        abi: artifacts[name].abi,
        functionName,
        args,
      });
    const token = await deploy("TestUSDC", []);
    const jackpot = await deploy("MockJackpot", [token]);
    // The community (fixture account 3) deposits into OperatorPayments and
    // names the ticket issuer (account 1) as the key that signs its purchases.
    const paymentToken = await deploy("TestPaymentToken", []);
    const paymentsContract = await deploy("OperatorPayments", []);
    await write(paymentToken, "TestPaymentToken", "mint", [accounts[3].address, 1_000_000_000n]);
    await write(paymentToken, "TestPaymentToken", "approve", [paymentsContract, 1_000_000_000n], 3);
    await write(paymentsContract, "OperatorPayments", "setSigner", [accounts[1].address], 3);
    await write(
      paymentsContract,
      "OperatorPayments",
      "deposit",
      [accounts[3].address, paymentToken, 100_000_000n],
      3,
    );
    return {
      rpcUrl: `http://127.0.0.1:${port}`,
      paymentToken,
      paymentsContract,
      child,
      rpc,
      publicClient,
      clients,
      deploy,
      write,
      read,
      token,
      jackpot,
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}
