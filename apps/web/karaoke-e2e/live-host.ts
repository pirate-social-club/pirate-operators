// Loopback-only acceptance host for the live community's Karaoke journey. It
// runs harness/karaoke-live.ts: the community application on the published
// first song's real post and lyric manifests, the operator with live audio,
// simulated ElevenLabs for alignment and transcription, and anvil for
// OperatorPayments and LearningRecords. It serves the built live page
// (dist/live) through the application, as the deployed Worker does, with two
// test-only substitutions: the MOSS wallet module signs with local fixture
// keys, and the client configuration names this host as the canonical origin.
// The operator's clock follows real time. Never packaged.
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { chain } from "../../../harness/chain.ts";
import { accounts } from "../../../harness/runtime.ts";
import {
  expectedKaraoke,
  firstSongFixture,
  karaokeLive,
  sungStream,
} from "../../../harness/karaoke-live.ts";
import { firstSong } from "../../../services/first-song-profile.ts";
import { digest } from "../../../packages/protocol/index.ts";
import type { KaraokeManifest } from "../../../packages/protocol/payments.ts";
import { readPublicResults } from "../../../packages/records/results-v2.ts";
import { readLearner } from "../../../packages/records/reader.ts";
import { LIVE_ALIGNMENT, LIVE_STEM_MS, LIVE_PORT } from "./live-fixture.ts";

const webRoot = process.cwd();
// The chain and contract helpers read repository-relative paths.
process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
const evm = await chain(19146);
const stop = () => evm.child.kill();
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stop();
    process.exit(0);
  });

const dist = resolve(webRoot, "dist/live");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const viteManifest = JSON.parse(
  await readFile(resolve(dist, ".vite/manifest.json"), "utf8"),
) as Record<string, { file: string }>;
const walletChunk =
  "/" +
  Object.entries(viteManifest).find(([source]) =>
    source.includes("@megaeth-labs/wallet-sdk"),
  )![1].file;
// Test-only stand-in for the MOSS SDK: the page's real calls, signed here.
const fakeWallet = `
const learner = new URLSearchParams(location.search).get("learner") ?? "5";
const sign = async (body) => (await fetch("/__fixture/sign", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ learner, ...body }) })).json();
export const mega = {
  async initialise() {},
  async connect() { return { address: (await sign({ kind: "address" })).address }; },
  async signMessage(message) { return { status: "success", signature: (await sign({ kind: "message", message })).signature }; },
  async signData({ data }) { return { status: "success", signature: (await sign({ kind: "typed", data })).signature }; },
};`;

async function asset(request: Request) {
  const path = new URL(request.url).pathname,
    file = resolve(dist, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(dist + sep))
    return new Response("not_found", { status: 404 });
  try {
    return new Response(await readFile(file), {
      headers: {
        "content-type": types[extname(file)] ?? "application/octet-stream",
      },
    });
  } catch {
    return new Response("not_found", { status: 404 });
  }
}

const manifest = await expectedKaraoke(LIVE_ALIGNMENT, LIVE_STEM_MS);
const live = await karaokeLive({
  evm,
  internalResults: process.env.KARAOKE_RESULTS_V2 === "1",
  now: Number((await evm.publicClient.getBlock()).timestamp) + 1,
  alignment: LIVE_ALIGNMENT,
  stemMs: LIVE_STEM_MS,
  // Take one sings every line; take two is interrupted by a reload.
  streams: [
    sungStream(manifest),
    sungStream(manifest, { toMs: 6000 }),
    { words: [] },
  ],
  operatorRoutes: ["127.0.0.1/attempt*"],
  assets: asset,
});
await live.publish();
const aligned = await live.align();
if (aligned.value.state !== "complete")
  throw new Error(`alignment failed: ${JSON.stringify(aligned.value)}`);

// The operator's and the application's clocks follow real time.
const t0 = Date.now(),
  base = live.now();
let ticking = false;
setInterval(() => {
  if (ticking) return;
  const target = base + Math.floor((Date.now() - t0) / 1000);
  if (target <= live.now()) return;
  ticking = true;
  void live
    .at(target)
    .catch((error) => console.error("clock", error))
    .finally(() => {
      ticking = false;
    });
}, 250);

const origin = `http://localhost:${LIVE_PORT}`;
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
const send = (
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value, (_, v) => typeof v === "bigint" ? String(v) : v));
};
const learnerOf = (value: unknown) => {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 5 || index > 9)
    throw new Error("fixture learners are 5 to 9");
  return accounts[index]!;
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === walletChunk) {
      response.writeHead(200, { "content-type": "text/javascript" });
      return response.end(fakeWallet);
    }
    if (url.pathname === "/__fixture/sign") {
      const input = JSON.parse((await body(request)).toString("utf8")),
        learner = learnerOf(input.learner);
      if (input.kind === "address")
        return send(response, 200, { address: learner.address });
      if (input.kind === "message")
        return send(response, 200, {
          signature: await learner.signMessage({ message: input.message }),
        });
      const { domain, types: typed, primaryType, message } = input.data;
      return send(response, 200, {
        signature: await learner.signTypedData({
          domain,
          types: typed,
          primaryType,
          message,
        }),
      });
    }
    if (url.pathname === "/__fixture/manifest")
      return send(response, 200, manifest);
    if (url.pathname === "/__fixture/operator")
      return send(response, 200, {
        attempts: (await live.operatorState("attempt:")).map((r) => r.value),
        audio: (await live.operatorState("audioRelay:")).map(
          ({ key, value }) => ({
            ticketId: key.slice("audioRelay:".length),
            lastSequence: (value as { lastSequence: number | null })
              .lastSequence,
          }),
        ),
        publications: await live.operatorState("publicationV2:"),
        bundles: await live.operatorState("workV2:"),
        transactions: (await live.operatorState("tx:")).map(({value}) => { const {raw, ...row} = value as Record<string, unknown>; return row; }),
        simulator: await live.simulatorLog(),
      });
    if (url.pathname === "/__fixture/records") {
      const learner = learnerOf(url.searchParams.get("learner"));
      const timed = (
        await live.json<KaraokeManifest>(
          await live.app(
            `/api/public/posts/${firstSongFixture.postId}/karaoke`,
          ),
        )
      ).value;
      if (live.resultsV2) {
        const results = await readPublicResults({ rpcUrl: evm.rpcUrl, contract: live.resultsV2, fromBlock: 0n,
          toBlock: await evm.publicClient.getBlockNumber({ cacheTime: 0 }), manifest: async (revision) => digest(timed) === revision ? timed : undefined,
          authenticateSource: async (candidate) => candidate.source?.lyricsSha256 === timed.source?.lyricsSha256 && candidate.lines.length === 23 });
        return send(response, 200, results.filter((r) => r.result.learner.toLowerCase() === learner.address.toLowerCase()));
      }
      return send(
        response,
        200,
        await readLearner(
          {
            rpcUrl: evm.rpcUrl,
            records: evm.recordsContract,
            manifest: async (revision) =>
              digest(timed) === revision ? timed : undefined,
          },
          learner.address,
        ),
      );
    }
    // Everything else goes through the community application, at its own origin.
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string" && name !== "host")
        headers.set(name, value);
    if (headers.has("origin")) headers.set("origin", firstSong.origin);
    const forwarded = await live.app(url.pathname + url.search, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await body(request),
    });
    const out: Record<string, string | string[]> = {};
    forwarded.headers.forEach((value, name) => {
      if (name !== "set-cookie" && name !== "content-length") out[name] = value;
    });
    const cookies = forwarded.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    let payload = Buffer.from(await forwarded.arrayBuffer());
    if (url.pathname === "/.well-known/pirate-client.json" && forwarded.ok) {
      const config = JSON.parse(payload.toString("utf8"));
      payload = Buffer.from(
        JSON.stringify({ ...config, canonicalOrigin: origin }),
      );
    }
    response.writeHead(forwarded.status, out);
    response.end(payload);
  } catch (error) {
    send(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}).listen(LIVE_PORT, "localhost");
console.log(
  `live karaoke host on ${origin}, wallet chunk ${walletChunk}, ${privateKeyToAccount(`0x${"13".repeat(32)}`).address}`,
);
