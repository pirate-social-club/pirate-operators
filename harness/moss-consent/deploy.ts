// Builds the temporary MOSS consent probe Worker into .local/moss-consent-probe
// for `cf deploy` from that directory. The MOSS SDK is not a repository
// dependency; it is bundled from MOSS_SDK_DIR, an install outside the repository.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const SDK_DIR = process.env.MOSS_SDK_DIR ?? join(homedir(), ".local/state/pirate-operators-moss-consent/sdk");
const OUT = resolve(".local/moss-consent-probe");
export const WORKER_NAME = "pirate-moss-consent-probe";

const browserEntry = `
import { mega } from "@megaeth-labs/wallet-sdk";
const $ = (id) => document.getElementById(id);
const stage = (name, state, detail = "") => {
  const li = document.createElement("li");
  li.textContent = name + ": " + state + (detail ? " (" + detail + ")" : "");
  $("stages").append(li);
};
const post = async (path, body) => {
  const response = await fetch(path, { method: "POST", body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.status);
  return value;
};
$("go").onclick = async () => {
  $("go").disabled = true;
  $("stages").textContent = "";
  let at = "initialise";
  try {
    await mega.initialise({ network: "testnet", logging: "error", debug: false, handshakeTimeoutMs: 45000 });
    stage("MOSS wallet loaded", "ok");
    at = "connect";
    const connected = await mega.connect();
    if (!connected || !connected.address) throw new Error("connection cancelled or no address (" + JSON.stringify(connected) + ")");
    stage("Connected", "ok", connected.address);
    const request = await post("consent-request", { address: connected.address });
    at = "signMessage";
    const message = await mega.signMessage(request.messageToSign);
    if (message.status !== "success" || !message.signature) throw new Error(JSON.stringify(message));
    stage("Message signed", "ok");
    at = "signData";
    const signed = await mega.signData({ data: { domain: request.domain, types: request.types, value: request.message } });
    if (signed.status !== "success" || !signed.signature) throw new Error(JSON.stringify(signed));
    stage("Consent signed", "ok");
    at = "analyse";
    const result = await post("analyse", { consent: request.message, signature: signed.signature, messageSignature: message.signature });
    stage("Checked over MegaETH RPC", "ok");
    $("result").value = JSON.stringify(result, null, 2);
    $("done").hidden = false;
  } catch (error) {
    stage("Failed at " + at, "error", (error && error.message) || String(error));
    $("go").disabled = false;
  }
};
$("copy").onclick = async () => {
  await navigator.clipboard.writeText($("result").value);
  $("copy").textContent = "Copied";
};`;

const page = (script: string) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOSS consent probe</title>
<style>body{font:16px system-ui;max-width:44rem;margin:2rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1rem}textarea{width:100%;height:16rem;font:12px ui-monospace,monospace}</style>
<h1>MOSS consent probe</h1>
<p>Testnet only. MOSS signs one plain message, then one learning-records consent. Nothing is sent on chain.</p>
<button id="go">Connect MOSS and sign</button>
<ol id="stages"></ol>
<div id="done" hidden><p>Copy this result and paste it back into the chat.</p><button id="copy">Copy result</button><textarea id="result" readonly></textarea></div>
<script type="module">${script.replaceAll("</script", "<\\/script")}</script>`;

async function main() {
  const browser = await build({
    stdin: { contents: browserEntry, resolveDir: SDK_DIR, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    nodePaths: [join(SDK_DIR, "node_modules")],
  });
  const worker = await build({
    entryPoints: ["harness/moss-consent/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    target: "es2022",
    define: { PROBE_PAGE: JSON.stringify(page(browser.outputFiles[0].text)) },
  });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "worker.js"), worker.outputFiles[0].text);
  writeFileSync(
    join(OUT, "cloudflare.config.ts"),
    `import { defineConfig } from "cf/config";
import * as entrypoint from "./worker.js" with { type: "cf-worker" };

// Temporary MOSS consent probe; delete the Worker once the signature is captured.
export default defineConfig({
  worker: { name: "${WORKER_NAME}", compatibilityDate: "2026-07-30", entrypoint },
});
`,
  );
  // cf deploy builds through Vite with the Cloudflare plugin, resolved from
  // the repository's node_modules above this directory.
  writeFileSync(
    join(OUT, "package.json"),
    `${JSON.stringify({ name: WORKER_NAME, private: true, type: "module", devDependencies: { "@cloudflare/vite-plugin": "2.0.0-beta.v.11", vite: "8.3.5" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(OUT, "vite.config.ts"),
    `import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [cloudflare()] });
`,
  );
  console.log(JSON.stringify({ step: "built", out: OUT, workerBytes: worker.outputFiles[0].text.length }));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
