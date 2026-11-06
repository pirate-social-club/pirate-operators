// Loopback-only acceptance host for live Karaoke capture. It boots the actual
// operator with live audio and a simulated ElevenLabs behind its outbound
// network, publishes the fixture song and issues a ticket for a fixture
// learner, then serves the built screen pointed at that operator socket.
// No chain, purchases or deployment. Never packaged.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { chain } from "../../../harness/chain.ts";
import { accounts } from "../../../harness/runtime.ts";
import { karaokeAudioWorkers } from "../../../harness/karaoke-audio-workers.ts";
import {
  fixtureLyrics,
  fixtureManifest,
} from "../../../harness/karaoke-fixture.ts";
import { post } from "../../../harness/karaoke-client.ts";
import type { Signed, Song, Ticket } from "../../../packages/protocol/index.ts";
import { fixtureInstrumentalWav } from "./fixture.ts";
import { captureStreams, CAPTURE_TRACK_MS } from "./capture-fixture.ts";

// The chain and contract helpers read repository-relative paths.
const webRoot = process.cwd();
process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
// Publishing pays the operator's admission fee on chain, so a disposable local
// chain runs beside the workers. Segment purchases are not made here.
const evm = await chain(19145);
const stop = () => evm.child.kill();
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
const runtime = await karaokeAudioWorkers({
  rpcUrl: evm.rpcUrl,
  paymentToken: evm.paymentToken,
  paymentsContract: evm.paymentsContract,
  recordsContract: evm.recordsContract,
  elevenLabsApiKey: "simulated-elevenlabs-key",
  streams: captureStreams,
  operatorRoutes: ["127.0.0.1/attempt*"],
});
const operatorUrl = await runtime.mf.ready;
/** Signs a fixture learner in; the community allows one open ticket per wallet. */
async function signIn(learner: (typeof accounts)[number]) {
  const challenge = await post<{ nonce: string; message: string }>(
    runtime.mf,
    "community",
    "/challenge",
    {
      wallet: learner.address,
    },
  );
  return (
    await post<{ token: string }>(runtime.mf, "community", "/session", {
      nonce: challenge.value.nonce,
      signature: await learner.signMessage({
        message: challenge.value.message,
      }),
    })
  ).value.token;
}
const session = await signIn(accounts[5]);
const song: Song = {
  communityId: "fixture-community",
  audio: `0x${(await readFile(new URL("../../../fixtures/original-tone.mp3", import.meta.url))).toString("hex")}`,
  title: "Capture fixture",
  lyrics: fixtureLyrics,
  artwork: "original-cover-fixture-v1",
  original: true,
};
const manifest = fixtureManifest(song);
const posted = await post<{ songHash: Hex; error?: string }>(
  runtime.mf,
  "community",
  "/songs",
  { song, manifest },
  session,
);
if (posted.status !== 200)
  throw new Error(`publish failed: ${JSON.stringify(posted.value)}`);
// Each page load is a new take, by its own fixture learner, with its own ticket.
let ticketId = "";
let takes = 0;
async function newTake() {
  const learner = accounts[5 + (takes++ % 4)];
  const issued = await post<Signed<Ticket> & { error?: string }>(
    runtime.mf,
    "community",
    "/tickets",
    { songHash: posted.value.songHash, sessionKey: learner.address },
    await signIn(learner),
  );
  if (issued.status !== 200)
    throw new Error(`ticket failed: ${JSON.stringify(issued.value)}`);
  ticketId = issued.value.body.ticketId;
  const proof = await learner.signMessage({ message: `connect:${ticketId}` });
  return {
    ticketId,
    socketUrl: new URL(
      `/attempt?ticketId=${ticketId}&proof=${proof}`,
      operatorUrl,
    ).href.replace(/^http/, "ws"),
  };
}

const dist = resolve(webRoot, "dist/karaoke");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const wav = fixtureInstrumentalWav(CAPTURE_TRACK_MS);
const json = (response: import("node:http").ServerResponse, value: unknown) => {
  response.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/__fixture/karaoke.json")
    return json(response, {
      title: "Capture fixture",
      instrumentalUrl: "/__fixture/instrumental.wav",
      lines: manifest.lines,
      capture: await newTake(),
    });
  if (path === "/__fixture/instrumental.wav") {
    response.writeHead(200, {
      "content-type": "audio/wav",
      "content-length": wav.length,
    });
    return response.end(wav);
  }
  if (path === "/__fixture/operator") {
    const state = await post<{ key: string; value: unknown }[]>(
      runtime.mf,
      "operator",
      "/__state",
      {},
    );
    const pick = (key: string) =>
      state.value.find((row) => row.key === key)?.value ?? null;
    const simulator = await (
      await runtime.mf.getWorker("elevenlabs")
    ).fetch("http://simulator.localhost/__simulator/log");
    return json(response, {
      manifest: manifest.lines,
      words: pick(`words:${ticketId}`) ?? [],
      attempt: pick(`attempt:${ticketId}`),
      simulator: await simulator.json(),
    });
  }
  const file = resolve(dist, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(dist + sep)) {
    response.writeHead(404);
    return response.end();
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
}).listen(4179, "127.0.0.1");
