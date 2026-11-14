import { createPublicClient, http, type PublicClient } from "viem";

/**
 * JSON-RPC methods that only read chain state. Only these are retried; every
 * other method, including eth_sendRawTransaction, is sent exactly once, so a
 * lost submission response is always reconciled by its caller, never resent.
 */
export const RETRYABLE_READ_METHODS: ReadonlySet<string> = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
]);
/** Delays before the second and third attempt of a read. */
export const READ_RETRY_DELAYS_MS = [250, 1000] as const;

const methodsOf = (body: unknown): string[] | null => {
  try {
    const parsed = JSON.parse(String(body));
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    return calls.map((call) => String(call?.method));
  } catch {
    return null;
  }
};
const transient = (response: Response) =>
  response.status === 429 || response.status >= 500;

/**
 * A fetch that retries a read-only JSON-RPC request a bounded number of times
 * after a network failure or a transient HTTP status. Anything else, or an
 * aborted request, is passed through on the first attempt.
 */
export function readRetryingFetch(
  // Looked up per request, so a replaced global fetch is always honoured.
  send: typeof fetch = (input, init) => fetch(input, init),
  sleep: (ms: number, signal?: AbortSignal | null) => Promise<void> = (
    ms,
    signal,
  ) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", stop);
        resolve();
      }, ms);
      const stop = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", stop, { once: true });
    }),
): typeof fetch {
  return async (input, init) => {
    const methods = methodsOf(init?.body);
    const retryable =
      methods !== null &&
      methods.length > 0 &&
      methods.every((method) => RETRYABLE_READ_METHODS.has(method));
    if (!retryable) return send(input, init);
    for (let attempt = 0; ; attempt++) {
      const last = attempt === READ_RETRY_DELAYS_MS.length;
      try {
        const response = await send(input, init);
        if (last || !transient(response)) return response;
        // A discarded transient response must not hold its connection.
        await response.body?.cancel().catch(() => {});
      } catch (error) {
        if (last || init?.signal?.aborted) throw error;
      }
      await sleep(READ_RETRY_DELAYS_MS[attempt]!, init?.signal);
    }
  };
}

/**
 * The selected application endpoint. Reads are retried a bounded number of times;
 * a transaction submission is never retried. Callers still verify chain 6343.
 */
export function megaethReadClient(
  observe?: (method: string, ms: number) => void,
  rpcUrl = "https://carrot.megaeth.com/rpc",
): PublicClient {
  const reads = readRetryingFetch();
  return createPublicClient({
    transport: http(rpcUrl, {
      // viem's own retry would also resend submissions; it stays disabled.
      retryCount: 0,
      timeout: 15000,
      fetchOptions: { redirect: "manual" },
      fetchFn: observe
        ? async (input, init) => {
            const method = JSON.parse(String(init?.body)).method as string;
            const started = performance.now();
            try {
              return await reads(input, init);
            } finally {
              observe(method, performance.now() - started);
            }
          }
        : reads,
    }),
  });
}
