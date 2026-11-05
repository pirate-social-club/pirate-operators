// The local workers of harness/runtime.ts, with the operator built from
// services/karaoke-audio-runtime.ts and its outbound traffic sent to the
// simulated ElevenLabs worker. The operator code calls the real provider
// address; only the network behind it is simulated. Local acceptance only.
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { keys, roles } from "./runtime.ts";
import type { SimulatedStream } from "./karaoke-elevenlabs-simulator.ts";

const roleKey = { community: 1, operator: 2, very: 4 } as const;
const bundle = async (entry: string) =>
  (
    await build({
      // Resolved from the repository root, so callers may run from any directory.
      entryPoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers"],
      target: "es2022",
    })
  ).outputFiles[0].text;

export async function karaokeAudioWorkers(
  options: {
    now?: number;
    cutoff?: number;
    /** Loopback anvil; omitted for capture-only acceptance without purchases. */
    rpcUrl?: string;
    paymentToken?: string;
    paymentsContract?: string;
    recordsContract?: string;
    /** Omitted to exercise an operator without a provider credential. */
    elevenLabsApiKey?: string;
    streams: SimulatedStream[];
    /** Miniflare routes that reach the operator directly, e.g. for a browser. */
    operatorRoutes?: string[];
  },
  persist = mkdtempSync(join(tmpdir(), "pirate-karaoke-audio-")),
) {
  const rpcOrigin = options.rpcUrl ? new URL(options.rpcUrl).origin : undefined;
  const zero = "0x0000000000000000000000000000000000000000";
  const payments = options.rpcUrl
    ? {
        RPC_URL: options.rpcUrl,
        PAYMENT_CHAIN_ID: "31337",
        PAYMENT_TOKEN: options.paymentToken ?? "",
        PAYMENTS_CONTRACT: options.paymentsContract ?? "",
        ...(options.recordsContract
          ? { RECORDS_CONTRACT: options.recordsContract }
          : {}),
        COMMUNITY_ADDRESS: privateKeyToAccount(keys[3]).address,
      }
    : // No chain: the operator's default quote profile, so the community trusts it.
      {
        PAYMENT_CHAIN_ID: "31337",
        PAYMENT_TOKEN: zero,
        PAYMENTS_CONTRACT: zero,
        COMMUNITY_ADDRESS: privateKeyToAccount(keys[3]).address,
      };
  const [service, operator, simulator] = await Promise.all([
    bundle("services/runtime.ts"),
    bundle("services/karaoke-audio-runtime.ts"),
    bundle("harness/karaoke-elevenlabs-simulator.ts"),
  ]);
  const rpcOnly = async (request: Request) => {
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
  };
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    durableObjectsPersist: persist,
    d1Persist: persist,
    workers: [
      ...roles.map((role) => ({
        name: role,
        modules: true,
        script: role === "operator" ? operator : service,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ROLE: role,
          LOCAL_ONLY: "pirate-local-skeleton",
          PRIVATE_KEY: keys[roleKey[role]],
          ISSUER: privateKeyToAccount(keys[1]).address,
          OPERATOR_ADDRESS: privateKeyToAccount(keys[2]).address,
          COMMUNITY_ID: "fixture-community",
          COMMUNITY_DOMAIN: "community.localhost",
          CUTOFF: String(options.cutoff ?? 1800000100),
          INITIAL_NOW: String(options.now ?? 1800000000),
          SIGNATURE_CHAIN_ID: "31337",
          ...payments,
          ...(role === "operator" && options.elevenLabsApiKey
            ? { ELEVENLABS_API_KEY: options.elevenLabsApiKey }
            : {}),
        },
        durableObjects: {
          STATE: { className: "ServiceState", useSQLite: true },
        },
        d1Databases: { DB: `${role}-db` },
        serviceBindings: { COMMUNITY: "community", OPERATOR: "operator" },
        outboundService: role === "operator" ? "elevenlabs" : rpcOnly,
        ...(role === "operator" && options.operatorRoutes
          ? { routes: options.operatorRoutes }
          : {}),
      })),
      {
        name: "elevenlabs",
        modules: true,
        script: simulator,
        compatibilityDate: "2026-07-30",
        bindings: {
          SIM_API_KEY: "simulated-elevenlabs-key",
          SIM_STREAMS: JSON.stringify(options.streams),
          ...(rpcOrigin ? { RPC_ORIGIN: rpcOrigin } : {}),
        },
      },
    ],
  });
  await mf.ready;
  return { mf, persist, chainId: 31337 as const };
}

export const SIMULATED_ELEVENLABS_KEY = "simulated-elevenlabs-key";
