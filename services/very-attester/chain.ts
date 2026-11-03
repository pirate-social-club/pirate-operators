import {
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  type Address,
} from "viem";
import { baseSepolia, foundry } from "viem/chains";
import { context, requireValue, type AttesterConfig } from "./policy.ts";

const abi = parseAbi([
  "function scope() view returns (bytes32)",
  "function drawingId() view returns (uint256)",
  "function attester() view returns (address)",
  "function settled() view returns (bool)",
  "function cancelled() view returns (bool)",
  "function finalized() view returns (bool)",
  "function deadline() view returns (uint256)",
  "function winnings() view returns (uint256)",
]);
export const rpcFor = (chainId: 31337 | 84532) =>
  chainId === 84532 ? "https://sepolia.base.org" : "http://127.0.0.1:18545";

export function poolInspector(config: AttesterConfig) {
  const client = createPublicClient({
    chain: config.chainId === 84532 ? baseSepolia : foundry,
    transport: http(rpcFor(config.chainId), { timeout: 10000, retryCount: 0 }),
  });
  return async (claimant: Address) => {
    requireValue(
      (await client.getChainId()) === config.chainId,
      "chain_mismatch",
    );
    const block = await client.getBlock();
    const base = { address: config.pool, abi, blockNumber: block.number };
    const [
      code,
      walletCode,
      scope,
      drawing,
      attester,
      settled,
      cancelled,
      finalized,
      deadline,
      winnings,
    ] = await Promise.all([
      client.getCode({ address: config.pool, blockNumber: block.number }),
      client.getCode({ address: claimant, blockNumber: block.number }),
      client.readContract({ ...base, functionName: "scope" }),
      client.readContract({ ...base, functionName: "drawingId" }),
      client.readContract({ ...base, functionName: "attester" }),
      client.readContract({ ...base, functionName: "settled" }),
      client.readContract({ ...base, functionName: "cancelled" }),
      client.readContract({ ...base, functionName: "finalized" }),
      client.readContract({ ...base, functionName: "deadline" }),
      client.readContract({ ...base, functionName: "winnings" }),
    ]);
    requireValue(
      code && code !== "0x" && keccak256(code) === config.poolCodeHash,
      "pool_code_mismatch",
    );
    requireValue(
      !walletCode ||
        walletCode === "0x" ||
        /^0xef0100[0-9a-fA-F]{40}$/.test(walletCode),
      "unsupported_wallet",
    );
    requireValue(
      scope === context(config).scope &&
        drawing.toString() === config.drawingId &&
        attester.toLowerCase() === config.attester.toLowerCase(),
      "pool_binding_mismatch",
    );
    requireValue(
      settled && !cancelled && !finalized && winnings > 0n,
      "registration_closed",
    );
    requireValue(
      deadline <= BigInt(Number.MAX_SAFE_INTEGER) &&
        block.timestamp <= BigInt(Number.MAX_SAFE_INTEGER),
      "invalid_pool_time",
    );
    return { deadline: Number(deadline), timestamp: Number(block.timestamp) };
  };
}
