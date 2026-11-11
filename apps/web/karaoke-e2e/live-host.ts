// Loopback-only acceptance host for the live community's Karaoke journey. It
// runs harness/karaoke-live.ts: the community application on the published
// first song's real post and lyric manifests, the operator with live audio,
// simulated ElevenLabs for alignment and transcription, and anvil for
// OperatorPayments and LearningRecords. It serves the built live page
// (dist/live) through the application, as the deployed Worker does, with two
// test-only substitutions: the MOSS wallet module signs with local fixture
// keys, and the client configuration names this host as the canonical origin.
// The operator's clock follows real time. With KARAOKE_RESULTS_V4=1 the
// learning records are LearningResultsV4 and signing in is the publication
// permission; LIVE_HOST_PORT and LIVE_CHAIN_PORT let it run beside the V2
// host. Never packaged.
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
import { resultsAbi, resultCommitment } from "../../../packages/protocol/learning-results.ts";
import { readPublicResults as readPublicResultsV4 } from "../../../packages/records/results-v3.ts";
import { keccak256 } from "viem";
import { readLearner } from "../../../packages/records/reader.ts";
import { LIVE_ALIGNMENT, LIVE_STEM_MS, LIVE_PORT } from "./live-fixture.ts";

const webRoot = process.cwd();
// The chain and contract helpers read repository-relative paths.
process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
const resultsV4 = process.env.KARAOKE_RESULTS_V4 === "1",
  port = Number(process.env.LIVE_HOST_PORT ?? LIVE_PORT);
const evm = await chain(Number(process.env.LIVE_CHAIN_PORT ?? 19146));
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
  resultsV4,
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

// The operator's and the application's clocks follow real time. With V4,
// the application's scheduled relay retries requested sign-ins as the Worker
// cron does; a sign-in is first relayed by the learner's first take.
const t0 = Date.now(),
  base = live.now();
let ticking = false;
setInterval(() => {
  if (ticking) return;
  const target = base + Math.floor((Date.now() - t0) / 1000);
  if (target <= live.now() && !resultsV4) return;
  ticking = true;
  void (async () => {
    if (target > live.now()) await live.at(target);
    if (resultsV4) await live.scheduledSignInRelay();
  })()
    .catch((error) => console.error("clock", error))
    .finally(() => {
      ticking = false;
    });
}, 250);

const origin = `http://localhost:${port}`;
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
  if (!Number.isSafeInteger(index) || index < 5 || index > 10)
    throw new Error("fixture learners are 5 to 10");
  // A separate public local key isolates the outro and refresh cases; learners need no gas.
  return index >= 9
    ? privateKeyToAccount(`0x${(index + 1).toString(16).padStart(64, "0")}`)
    : accounts[index]!;
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
    if (url.pathname === "/__fixture/result-events") {
      if (!live.resultsV2) throw Error("fixture V2 result source required");
      const learner = learnerOf(url.searchParams.get("learner"));
      const head = await evm.publicClient.getBlock({ blockTag: "latest" });
      const logs = await evm.publicClient.getContractEvents({
        address: live.resultsV2, abi: resultsAbi, eventName: "ResultPublished",
        args: { learner: learner.address },
        fromBlock: 0n, toBlock: head.number, strict: true,
      });
      // Preserve every raw event, including all revisions. Reduction to one
      // current result per session would hide duplicate-publication evidence.
      const events = await Promise.all(logs.map(async (log) => {
        const [block, receipt] = await Promise.all([
          evm.publicClient.getBlock({ blockNumber: log.blockNumber }),
          evm.publicClient.getTransactionReceipt({ hash: log.transactionHash }),
        ]);
        const owned = receipt.logs.filter((entry) => entry.logIndex === log.logIndex);
        return {
          sessionId: log.args.result.sessionId,
          learner: log.args.result.learner,
          revision: log.args.result.revision,
          commitment: log.args.commitment,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          verified:
            !log.removed && block.hash === log.blockHash &&
            receipt.status === "success" && receipt.blockHash === log.blockHash &&
            log.args.sessionId === log.args.result.sessionId &&
            log.args.revision === log.args.result.revision &&
            log.args.learner.toLowerCase() === log.args.result.learner.toLowerCase() &&
            resultCommitment(log.args.result, log.args.outcomes) === log.args.commitment &&
            owned.length === 1 && owned[0]!.address.toLowerCase() === log.address.toLowerCase() &&
            owned[0]!.data === log.data &&
            owned[0]!.topics.join(":") === log.topics.join(":"),
        };
      }));
      if ((await evm.publicClient.getBlock({ blockNumber: head.number })).hash !== head.hash)
        throw Error("fixture result head changed");
      return send(response, 200, events);
    }
    if (url.pathname === "/__fixture/records") {
      const learner = learnerOf(url.searchParams.get("learner"));
      const timed = (
        await live.json<KaraokeManifest>(
          await live.app(
            `/api/public/posts/${firstSongFixture.postId}/karaoke`,
          ),
        )
      ).value;
      if (live.resultsV4) {
        const contract = live.resultsV4;
        const results = await readPublicResultsV4(
          {
            contract,
            codeHash: keccak256((await evm.publicClient.getCode({ address: contract }))!),
            version: 4,
          },
          {
            rpcUrl: evm.rpcUrl,
            chainId: 31337,
            communityId: live.config.communityId,
            fromBlock: 0n,
            toBlock: await evm.publicClient.getBlockNumber({ cacheTime: 0 }),
            karaokeManifest: async (revision) => (digest(timed) === revision ? timed : undefined),
            authenticateKaraoke: async (candidate) =>
              candidate.source?.lyricsSha256 === timed.source?.lyricsSha256 && candidate.lines.length === 23,
          },
        );
        return send(
          response,
          200,
          results
            .filter((r) => r.result.learner.toLowerCase() === learner.address.toLowerCase())
            .map((r) => ({
              verified: r.verified,
              problems: r.problems,
              enrollmentId: r.result.enrollmentId,
              lines: r.assessment?.activity === 1 ? r.assessment.lines : [],
            })),
        );
      }
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
    if (url.pathname === "/__fixture/authorizations") {
      const learner = learnerOf(url.searchParams.get("learner"));
      const rows = await live.db
        .prepare(
          "SELECT authorization_id,issued_at,state FROM learning_authorizations WHERE subject=? ORDER BY issued_at",
        )
        .bind(learner.address.toLowerCase())
        .all();
      return send(response, 200, rows.results);
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
}).listen(port, "localhost");
console.log(
  `live karaoke host on ${origin}, wallet chunk ${walletChunk}, ${privateKeyToAccount(`0x${"13".repeat(32)}`).address}`,
);
