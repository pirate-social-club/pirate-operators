import { createPublicClient, http, type PublicClient } from "viem";

/** Read-only fixed application endpoint. Callers still verify chain 6343. */
export function megaethReadClient(
  observe?: (method: string, ms: number) => void,
): PublicClient {
  return createPublicClient({
    transport: http("https://carrot.megaeth.com/rpc", {
      retryCount: 0,
      timeout: 15000,
      fetchOptions: { redirect: "manual" },
      fetchFn: observe
        ? async (input, init) => {
            const method = JSON.parse(String(init?.body)).method as string;
            const started = performance.now();
            try {
              return await fetch(input, init);
            } finally {
              observe(method, performance.now() - started);
            }
          }
        : undefined,
    }),
  });
}
