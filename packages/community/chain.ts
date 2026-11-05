import { createPublicClient, http, type PublicClient } from "viem";

/** Read-only fixed application endpoint. Callers still verify chain 6343. */
export function megaethReadClient(): PublicClient {
  return createPublicClient({
    transport: http("https://carrot.megaeth.com/rpc", {
      retryCount: 0,
      timeout: 15000,
      fetchOptions: { redirect: "manual" },
    }),
  });
}
