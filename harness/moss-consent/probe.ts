// Manual, opt-in probe of a real MOSS learner consent
// (docs/learning-records-contract.md section 9). Never runs in CI. It serves
// one page on 127.0.0.1 that connects the MOSS wallet on MegaETH testnet and
// asks it to sign a LearningRecords Consent. The server then classifies the
// signature and checks it over the MegaETH RPC. It sends no transaction.
//
// The MOSS SDK is not a repository dependency: install it outside the
// repository and point MOSS_SDK_DIR at that directory's node_modules parent.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  isErc6492Signature,
  isErc8010Signature,
  keccak256,
  parseErc8010Signature,
  size,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { check } from "../../packages/protocol/index.ts";
import {
  ACTIVITY_KARAOKE,
  CONSENT_LIFETIME_S,
  consentMessage,
  consentTypes,
  recordsAbi,
  recordsDomain,
  scoringPolicyOf,
  songKeyOf,
  standInSong,
  type Consent,
} from "../../packages/protocol/records.ts";

const RPC = process.env.MEGAETH_RPC ?? "https://carrot.megaeth.com/rpc";
const RECORDS = "0x0eae432258c5954cf3d06e707acb3490a2f20a12" as Address;
const OPERATOR = "0x14B90A55657D9695A727254EAec5E0e32D20d602" as Address; // the records grader
const STATE = join(homedir(), ".local/state/pirate-operators-moss-consent");
const SDK_DIR = process.env.MOSS_SDK_DIR ?? join(STATE, "sdk");
const PORT = Number(process.env.PORT ?? 18790);
// The four-line fixture manifest's root (fixtures/learning-records-v1.json).
const LINES_ROOT = "0x307f78ef4bd386a2dec53316e75f678f689bb009e935b531f2f0fe44ae632c07" as Hex;

const megaeth = defineChain({
  id: 6343,
  name: "MegaETH testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const chain = createPublicClient({ chain: megaeth, transport: http(RPC, { timeout: 20_000 }) });
const song = standInSong(6343, "moss-consent-probe", keccak256(stringToBytes("moss-consent-probe-song")));
const pending = new Map<string, Consent>();

async function consentFor(learner: Address): Promise<Consent> {
  const now = Number((await chain.getBlock()).timestamp);
  return {
    learner,
    attemptId: keccak256(stringToBytes(`moss-consent-probe:${learner}:${now}`)),
    songKey: songKeyOf(song),
    contentRevision: keccak256(stringToBytes("moss-consent-probe-manifest")),
    linesRoot: LINES_ROOT,
    linesTotal: 4,
    activity: ACTIVITY_KARAOKE,
    grader: OPERATOR,
    scoringPolicy: scoringPolicyOf(5),
    expiresAt: now + CONSENT_LIFETIME_S,
  };
}

/** What the signature is, whether the RPC accepts it, and what the contract would do with it today. */
async function analyse(consent: Consent, signature: Hex) {
  const domain = recordsDomain(6343, RECORDS);
  const code = await chain.getCode({ address: consent.learner });
  const erc8010 = isErc8010Signature(signature);
  const wrapped = erc8010 ? parseErc8010Signature(signature) : undefined;
  const verifiedOverRpc = await chain
    .verifyTypedData({
      address: consent.learner,
      domain,
      types: consentTypes,
      primaryType: "Consent",
      message: consentMessage(consent),
      signature,
    })
    .catch((error: Error) => `error: ${error.message.split("\n")[0]}`);
  // openAttempt as the grader would send it, simulated only.
  const simulate = (sig: Hex) =>
    chain
      .call({
        account: OPERATOR,
        to: RECORDS,
        data: encodeFunctionData({
          abi: recordsAbi,
          functionName: "openAttempt",
          args: [consentMessage(consent), sig, { ...song, chainId: 6343n }],
        }),
      })
      .then(() => "would_succeed")
      .catch((error: Error) => {
        const reason = /reverted with the following reason:\s*(\S+)/.exec(error.message)?.[1];
        return `reverts: ${reason ?? error.message.split("\n")[0]}`;
      });
  return {
    learner: consent.learner,
    learnerCode: code ?? "0x",
    signatureBytes: size(signature),
    signatureHash: keccak256(signature),
    erc6492: isErc6492Signature(signature),
    erc8010,
    erc8010Parts: wrapped && "authorization" in wrapped && wrapped.authorization
      ? {
          delegate: wrapped.authorization.address,
          authorizationChainId: wrapped.authorization.chainId,
          authorizationNonce: wrapped.authorization.nonce,
          initializer: wrapped.address ?? null,
          initDataBytes: wrapped.data ? size(wrapped.data) : 0,
          innerSignatureBytes: size(wrapped.signature),
        }
      : null,
    verifiedOverRpc,
    openAttemptAsSigned: await simulate(signature),
    openAttemptWithInnerSignature: wrapped ? await simulate(wrapped.signature) : null,
  };
}

const page = (bundle: string) => `<!doctype html>
<meta charset="utf-8"><title>MOSS consent probe</title>
<style>body{font:16px system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1rem}pre{white-space:pre-wrap;background:#f4f4f4;padding:1rem}</style>
<h1>MOSS consent probe</h1>
<p>Testnet only. This asks your MOSS wallet to sign one learning-records consent. Nothing is sent on chain.</p>
<button id="go">Connect MOSS and sign</button>
<pre id="out"></pre>
<script type="module">${bundle}</script>`;

const browserEntry = `
import { mega } from "@megaeth-labs/wallet-sdk";
const out = document.getElementById("out");
const say = (t) => { out.textContent = t; };
document.getElementById("go").onclick = async () => {
  try {
    say("Opening MOSS…");
    await mega.initialise({ network: "testnet", logging: "error", debug: false, handshakeTimeoutMs: 45000 });
    const connected = await mega.connect();
    if (!connected?.address) throw new Error("MOSS connection was cancelled.");
    const request = await (await fetch("/consent-request", { method: "POST", body: JSON.stringify({ address: connected.address }) })).json();
    say("Approve the consent in MOSS…");
    const signed = await mega.signData({ data: { domain: request.domain, types: request.types, value: request.message } });
    if (signed.status !== "success" || !signed.signature) throw new Error("The consent was not signed.");
    const result = await (await fetch("/consent", { method: "POST", body: JSON.stringify({ id: request.id, signature: signed.signature }) })).json();
    say(JSON.stringify(result, null, 2));
  } catch (error) { say("Failed: " + (error?.message ?? error)); }
};`;

async function main() {
  check((await chain.getChainId()) === 6343, "refusing_non_megaeth_testnet_chain");
  const bundled = await build({
    stdin: { contents: browserEntry, resolveDir: SDK_DIR, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    nodePaths: [join(SDK_DIR, "node_modules")],
  });
  const html = page(bundled.outputFiles[0].text.replaceAll("</script", "<\\/script"));
  const body = async (req: import("node:http").IncomingMessage) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    check(text.length <= 70000, "request_too_large");
    return JSON.parse(text);
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(html);
      }
      if (req.method === "POST" && req.url === "/consent-request") {
        const { address } = await body(req);
        check(/^0x[0-9a-fA-F]{40}$/.test(address), "invalid_address");
        const consent = await consentFor(address);
        pending.set(consent.attemptId, consent);
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            id: consent.attemptId,
            domain: recordsDomain(6343, RECORDS),
            types: consentTypes,
            message: { ...consent, expiresAt: String(consent.expiresAt) },
          }),
        );
      }
      if (req.method === "POST" && req.url === "/consent") {
        const { id, signature } = await body(req);
        const consent = pending.get(id);
        check(consent && /^0x[0-9a-fA-F]+$/.test(signature), "unknown_request");
        const result = await analyse(consent, signature);
        // The full signature and consent stay private, for the on-chain step.
        mkdirSync(STATE, { recursive: true, mode: 0o700 });
        writeFileSync(join(STATE, `consent-${id}.json`), JSON.stringify({ consent, signature, song: { ...song } }, null, 2), {
          mode: 0o600,
        });
        const evidence = { kind: "moss-consent-probe", recordedAt: new Date().toISOString(), chainId: 6343, records: RECORDS, attemptId: id, ...result };
        mkdirSync("docs/evidence", { recursive: true });
        writeFileSync(`docs/evidence/moss-consent-probe-${evidence.recordedAt.slice(0, 10)}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
        console.log(JSON.stringify({ step: "analysed", ...result }));
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(result));
      }
      res.statusCode = 404;
      res.end("not_found");
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  server.listen(PORT, "127.0.0.1", () => console.log(JSON.stringify({ step: "ready", url: `http://127.0.0.1:${PORT}/` })));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
