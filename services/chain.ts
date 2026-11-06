import {
  decodeFunctionResult,
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  paymentsAbi,
  type Receipt,
  type ReceiptLog,
} from "../packages/protocol/payments.ts";

/** JSON-RPC to the payment chain. Local runs reach only loopback anvil. */
export async function rpc<T>(url: string | undefined, method: string, params: unknown[]) {
  check(url, "payment_rpc_unconfigured");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const value = (await response.json()) as {
    result?: T;
    error?: { code?: number; message?: string };
  };
  if (value.error)
    throw new RpcError(value.error.code ?? 0, value.error.message ?? "rpc_error");
  return value.result as T;
}
export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
export const receiptOf = (url: string | undefined, hash: Hex) =>
  rpc<Receipt | null>(url, "eth_getTransactionReceipt", [hash]);

/** Rereads a receipt a few times before reporting it unknown. */
export async function receiptWithin(url: string | undefined, hash: Hex, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const receipt = await receiptOf(url, hash);
    if (receipt) return receipt;
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}
export const pendingNonce = async (url: string | undefined, address: Address) =>
  Number(BigInt(await rpc<Hex>(url, "eth_getTransactionCount", [address, "pending"])));
export const latestNonce = async (url: string | undefined, address: Address) =>
  Number(BigInt(await rpc<Hex>(url, "eth_getTransactionCount", [address, "latest"])));
export const gasPrice = async (url: string | undefined) =>
  BigInt(await rpc<Hex>(url, "eth_gasPrice", []));

/**
 * Broadcasts a signed transaction and returns its receipt, or null when the
 * outcome is unknown. MegaETH's realtime method returns the receipt in one
 * call; `realtime transaction expired` is a wait expiry, not a rejection.
 */
export async function sendRaw(url: string | undefined, raw: Hex, hash: Hex, realtime: boolean) {
  try {
    if (realtime)
      return await rpc<Receipt>(url, "realtime_sendRawTransaction", [raw, 3000]);
    await rpc<Hex>(url, "eth_sendRawTransaction", [raw]);
  } catch (error) {
    if (!(error instanceof RpcError)) return null;
    // A rebroadcast of a transaction already known or mined, or a wait expiry.
  }
  return receiptWithin(url, hash, 3);
}

/** Reads OperatorPayments state, optionally at a fixed block for a consistent view. */
export async function readPayments<T>(
  url: string | undefined,
  payments: Address,
  functionName: "signer" | "balance" | "redemption" | "closed",
  args: readonly unknown[],
  blockTag: string = "latest",
) {
  const data = encodeFunctionData({
    abi: paymentsAbi,
    functionName,
    args: args as never,
  });
  const result = await rpc<Hex>(url, "eth_call", [{ to: payments, data }, blockTag]);
  return decodeFunctionResult({
    abi: paymentsAbi,
    functionName,
    data: result,
  }) as T;
}
export const getLogs = (url: string | undefined, filter: Record<string, unknown>) =>
  rpc<ReceiptLog[]>(url, "eth_getLogs", [filter]);
