import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

// Public fixture keys. These accounts exist only on the disposable local chain.
export const keys = Array.from(
  { length: 9 },
  (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex,
);
export const accounts = keys.map((key) => privateKeyToAccount(key));
export const roles = [
  "community",
  "operator",
  "payer",
  "very",
  "provider",
] as const;
export async function workers(
  persist = mkdtempSync(join(tmpdir(), "pirate-operators-")),
  options: {
    keys?: readonly Hex[];
    chainId?: 31337 | 84532;
    now?: number;
    cutoff?: number;
    paymentProvider?: (request: Request) => Promise<Response>;
  } = {},
) {
  const bundle = await build({
    entryPoints: ["services/runtime.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
    target: "es2022",
  });
  const script = bundle.outputFiles[0].text;
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    durableObjectsPersist: persist,
    workers: roles.map((role, i) => ({
      name: role,
      modules: true,
      script,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        ROLE: role,
        LOCAL_ONLY: "pirate-local-skeleton",
        PRIVATE_KEY: (options.keys ?? keys)[i + 1],
        ISSUER: privateKeyToAccount((options.keys ?? keys)[1]).address,
        OPERATOR_ADDRESS: privateKeyToAccount((options.keys ?? keys)[2])
          .address,
        COMMUNITY_ID: "fixture-community",
        COMMUNITY_DOMAIN: "community.localhost",
        CUTOFF: String(options.cutoff ?? 1800000100),
        INITIAL_NOW: String(options.now ?? 1800000000),
        SIGNATURE_CHAIN_ID: String(options.chainId ?? 31337),
      },
      durableObjects: { STATE: { className: "ServiceState", useSQLite: true } },
      serviceBindings: {
        COMMUNITY: "community",
        OPERATOR: "operator",
        PAYER: "payer",
        PROVIDER: options.paymentProvider ?? "provider",
      },
      outboundService: () =>
        new Response("external_network_disabled", { status: 403 }),
    })),
  });
  await mf.ready;
  return { mf, persist };
}
