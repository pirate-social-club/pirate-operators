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
export const roles = ["community", "operator", "very"] as const;
// Fixture key per role: 1 issuer, 2 operator, 3 community payer, 4 attester.
const roleKey = { community: 1, operator: 2, very: 4 } as const;
export async function workers(
  persist = mkdtempSync(join(tmpdir(), "pirate-operators-")),
  options: {
    keys?: readonly Hex[];
    chainId?: 31337 | 6343;
    now?: number;
    cutoff?: number;
    /** Loopback anvil RPC; the only outbound address workers may reach. */
    rpcUrl?: string;
    paymentToken?: string;
    paymentsContract?: string;
  } = {},
) {
  const rpcOrigin = options.rpcUrl ? new URL(options.rpcUrl).origin : undefined;
  const payments = options.rpcUrl
    ? {
        RPC_URL: options.rpcUrl,
        PAYMENT_CHAIN_ID: "31337",
        PAYMENT_TOKEN: options.paymentToken ?? "",
        PAYMENTS_CONTRACT: options.paymentsContract ?? "",
        // Fixture account 3 is the community's admin address in OperatorPayments.
        COMMUNITY_ADDRESS: privateKeyToAccount((options.keys ?? keys)[3]).address,
      }
    : {};
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
    d1Persist: persist,
    workers: roles.map((role) => ({
      name: role,
      modules: true,
      script,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        ROLE: role,
        LOCAL_ONLY: "pirate-local-skeleton",
        PRIVATE_KEY: (options.keys ?? keys)[roleKey[role]],
        ISSUER: privateKeyToAccount((options.keys ?? keys)[1]).address,
        OPERATOR_ADDRESS: privateKeyToAccount((options.keys ?? keys)[2])
          .address,
        COMMUNITY_ID: "fixture-community",
        COMMUNITY_DOMAIN: "community.localhost",
        CUTOFF: String(options.cutoff ?? 1800000100),
        INITIAL_NOW: String(options.now ?? 1800000000),
        SIGNATURE_CHAIN_ID: String(options.chainId ?? 31337),
        ...payments,
      },
      durableObjects: { STATE: { className: "ServiceState", useSQLite: true } },
      d1Databases: { DB: `${role}-db` },
      serviceBindings: {
        COMMUNITY: "community",
        OPERATOR: "operator",
      },
      outboundService: async (request: Request) => {
        if (!rpcOrigin || new URL(request.url).origin !== rpcOrigin)
          return new Response("external_network_disabled", { status: 403 });
        const response = await fetch(request.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: await request.text(),
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        });
      },
    })),
  });
  await mf.ready;
  return { mf, persist, chainId: options.chainId ?? 31337 };
}
