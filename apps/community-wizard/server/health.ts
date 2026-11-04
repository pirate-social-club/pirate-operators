export class HealthPending extends Error {
  constructor() {
    super(
      "Alchemy completed, but the expected HTTPS receipt is not ready yet. Retry the health check; do not recreate resources.",
    );
  }
}
export async function waitForHealth(
  origin: string,
  planId: string,
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    budgetMs?: number;
  } = {},
) {
  const get = options.fetch ?? fetch,
    now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.budgetMs ?? 180_000);
  for (let attempt = 0; now() < deadline; attempt++) {
    try {
      const response = await get(`${origin}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(15_000, deadline - now())),
        ),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Not ready");
      }
      if (Number(response.headers.get("content-length") ?? 0) > 4096) {
        await response.body?.cancel();
        throw new Error("Oversize receipt");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing receipt");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 4096) throw new Error("Oversize receipt");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const receipt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        receipt.schema === "pirate.community-setup/1" &&
        receipt.planId === planId &&
        receipt.infrastructure === "provisioned"
      )
        return;
    } catch {
      /* Transient DNS/TLS, stale version or receipt mismatch never count as success. */
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(1000 * 2 ** Math.min(attempt, 4), remaining));
  }
  throw new HealthPending();
}
