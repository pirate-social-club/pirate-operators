import { build } from "esbuild";
import { Miniflare, type Request as MiniflareRequest } from "miniflare";
import { fileURLToPath } from "node:url";
import { karaokeLocalSessions } from "./karaoke-local-session.ts";
import type { Hex, Address } from "viem";
import {
  createKaraokeIngressBinding,
  localKaraokeTranscriber,
  localKaraokeUpgrade,
} from "./karaoke-local-bridge.ts";

const socketGateway = `
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/attempt" ||
        request.headers.get("origin") !== env.ORIGIN ||
        request.headers.get("x-pirate-local-karaoke-ingress") !== env.INGRESS ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 404 });
    return env.OPERATOR.fetch(request);
  },
};
`;

/** Alpha mounts this in its existing bounded HTTPS preview. No listener is
 * created on import and the provider egress path is disabled. */
export async function mountPrivateLocalKaraoke(options: {
  origin: string;
  persist: string;
  model: { python: string; script: string; model: string; modelSha256: Hex };
  profile: { communityId: Hex; profileHash: Hex; runtimeJson: string; speechPolicyJson: string };
  operator: { key: Hex; address: Address; issuer: Address; community: Address; token: Address; payments: Address };
  quote: { validFrom: number; validUntil: number };
  db: D1Database;
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || !["localhost", "127.0.0.1"].includes(origin.hostname) ||
      origin.origin !== options.origin || options.quote.validFrom >= options.quote.validUntil)
    throw Error("karaoke_local_mount_scope_invalid");
  const ingress = createKaraokeIngressBinding();
  const recognizer = localKaraokeTranscriber(options.model);
  const sessions = karaokeLocalSessions(options.db, {
    origin: options.origin, communityId: options.profile.communityId,
  });
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../services/karaoke-audio-runtime.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser",
    external: ["cloudflare:workers"], target: "es2022",
  });
  const mf = new Miniflare({
    host: "127.0.0.1", port: 0, durableObjectsPersist: options.persist,
    workers: [
      {
        name: "karaoke-socket-gateway", modules: true, script: socketGateway,
        compatibilityDate: "2026-07-30",
        bindings: { ORIGIN: options.origin, INGRESS: ingress },
        serviceBindings: { OPERATOR: "private-karaoke" },
        outboundService: async () => new Response(null, { status: 403 }),
      },
      {
        name: "private-karaoke", modules: true, script: bundle.outputFiles[0]!.text,
        compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          STATE: { className: "ServiceState", useSQLite: true },
          SPEECH_BUDGET: { className: "SpeechBudget", useSQLite: true },
        },
        bindings: {
          ROLE: "operator", LOCAL_ONLY: "pirate-local-skeleton", SERVICE_MODE: "internal",
          COMMUNITY_ID: options.profile.communityId, COMMUNITY_DOMAIN: origin.hostname,
          PRIVATE_KEY: options.operator.key, ISSUER: options.operator.issuer,
          OPERATOR_ADDRESS: options.operator.address, COMMUNITY_ADDRESS: options.operator.community,
          PAYMENT_TOKEN: options.operator.token, PAYMENTS_CONTRACT: options.operator.payments,
          PAYMENT_CHAIN_ID: "6343", SIGNATURE_CHAIN_ID: "6343", CUTOFF: "0",
          QUOTE_VALID_FROM: String(options.quote.validFrom), QUOTE_VALID_UNTIL: String(options.quote.validUntil),
          HISTORY_RETENTION_DAYS: "1", STUDY_PRIVATE_V5_PROFILE: options.profile.runtimeJson,
          SPEECH_ADMISSION_CONFIG: options.profile.speechPolicyJson,
          KARAOKE_PRIVATE_PROFILE: options.profile.profileHash, KARAOKE_LOCAL_MODEL_SHA256: options.model.modelSha256,
          KARAOKE_LOCAL_BROWSER_ORIGIN: options.origin, KARAOKE_LOCAL_INGRESS: ingress,
        },
        serviceBindings: {
          KARAOKE_LOCAL_TRANSCRIBER: (request: MiniflareRequest) => recognizer.fetch(request as unknown as Request),
          KARAOKE_LOCAL_SESSION_GATE: (request: MiniflareRequest) => sessions.fetch(request as unknown as Request),
        },
        outboundService: async () => new Response(null, { status: 403 }),
      },
    ],
  });
  try {
    const ready = new URL(await mf.ready);
    // The listener is specifically bound to IPv4 loopback.
    ready.hostname = "127.0.0.1";
    const operator = await mf.getWorker("private-karaoke");
    const socket = localKaraokeUpgrade({
      origin: options.origin, operator: ready, sessions, ingressBinding: ingress,
    });
    const paths = new Set(["/quote", "/prepare", "/attempt-start", "/result", "/record", "/history"]);
    return {
      upgrade: socket.upgrade,
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== "http://service" || !paths.has(url.pathname) || request.method !== "POST")
          return new Response(null, { status: 404 });
        const body = await request.text();
        if (body.length > 32000) return new Response(null, { status: 413 });
        const response = await operator.fetch(request.url, {
          method: "POST", headers: { "content-type": "application/json" }, body,
        });
        return new Response(await response.text(), {
          status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
      async close() {
        socket.close();
        sessions.close();
        await recognizer.close();
        await mf.dispose();
      },
    };
  } catch (error) {
    sessions.close();
    await recognizer.close();
    await mf.dispose();
    throw error;
  }
}
