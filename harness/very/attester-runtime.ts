import { build } from "esbuild";
import { Miniflare } from "miniflare";
import type { Hex } from "viem";
import type { AttesterConfig } from "../../services/very-attester/policy.ts";
import { rpcFor } from "../../services/very-attester/chain.ts";

// Local runtime only. No provider fallback exists in the Worker. Offline tests
// replace outbound transport explicitly; the live harness uses pinned hosts.
export async function attesterRuntime(
  config: AttesterConfig,
  key: Hex,
  persist: string,
  options: {
    now?: number;
    outbound?: (request: Request) => Promise<Response>;
  } = {},
) {
  const bundle = await build({
    entryPoints: ["services/very-attester/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    target: "es2022",
  });
  const allowed = new Set([
    rpcFor(config.chainId),
    "https://verify.very.org/api/v1/verify",
  ]);
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    modules: true,
    script: bundle.outputFiles[0].text,
    // Match the repository's pinned local workerd, not today's deployment date.
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjectsPersist: persist,
    durableObjects: {
      ATTESTER: { className: "VeryAttesterState", useSQLite: true },
    },
    bindings: {
      CONFIG: JSON.stringify(config),
      PRIVATE_KEY: key,
      ENABLE: "testnet-very-attester/1",
      ...(options.now === undefined
        ? {}
        : { LOCAL_TEST_NOW: String(options.now) }),
    },
    outboundService:
      options.outbound ??
      (async (request) => {
        if (!allowed.has(request.url.replace(/\/$/, "")))
          return new Response("outbound_refused", { status: 403 });
        const response = await fetch(request.url, {
          method: request.method,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: await request.arrayBuffer(),
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        const reader = response.body?.getReader();
        if (!reader)
          return new Response("missing_provider_body", { status: 502 });
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 1_048_576)
              throw new Error("provider_response_too_large");
            parts.push(part.value);
          }
          // Node has decompressed the body. Do not forward transport/encoding
          // headers into workerd and accidentally decode it a second time.
          return new Response(Buffer.concat(parts), {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          });
        } finally {
          await reader.cancel();
        }
      }),
  });
  try {
    await mf.ready;
    return mf;
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
