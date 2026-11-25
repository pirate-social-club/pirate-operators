// Derived from long-window2-30d7939/wallet-bridge-v25.ts. No automated setup actions.
// Only the MOSS SDK transport is a fixture. The helper and product screens are real.
import assert from "node:assert/strict";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash, X509Certificate } from "node:crypto";
import { appendFileSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { verifyTypedData } from "viem";
import type { Browser, Page } from "../../apps/community-wizard/node_modules/playwright-core/types/types.d.ts";
import { web2Owner } from "../../test/fixtures/web2-first-song-chain.ts";
import { canonical, object } from "../../packages/community/common.ts";
import { enrollmentTypedData, parseEnrollment, parsePlan } from "../../packages/community/hosted-enrollment.ts";
import { ownerAuthorizationTypedData } from "../../packages/community/owner-authorization-typed-data.ts";
import { readPrivateJSON } from "../../deploy/linux/installed-records.ts";
import type { Journal } from "../../apps/community-wizard/server/web2-journal.ts";
import type { SigningJournal } from "../../apps/community-wizard/server/web2-signing-journal.ts";
import { OriginalObserver } from "./original-observer.ts";
const require = createRequire(new URL("../../apps/community-wizard/package.json", import.meta.url));
const pw: typeof import("../../apps/community-wizard/node_modules/@playwright/test/index.d.ts") = require("@playwright/test");
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const wire = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? String(v) : v));
export const certificatePin = (pem: Buffer) => createHash("sha256")
  .update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64");
interface Inputs { executable: string; executableSha256: string; artifacts: string;
  signal: AbortSignal; onBrowser(browser: Browser): void }
// Append-only rehearsal-progress rows shared with the launcher; failure-tolerant diagnostic capture.
const browserMark = (op: string, event: "enter" | "return") => {
 try {
  const root = process.env.PIRATE_MANUAL_RUN_ROOT;
  if (root && root.startsWith("/"))
   appendFileSync(join(root, "logs", "native-progress.ndjson"), JSON.stringify({ at: new Date().toISOString(), kind: "op", op, event }) + "\n");
 } catch { /* diagnostic capture never affects the rehearsal */ }
};
async function virtualCapture(artifacts: string): Promise<string[]> {
  const root = process.env.PIRATE_MANUAL_RUN_ROOT;
  assert(root && root.startsWith("/"), "original_virtual_media_root_required");
  async function pinned(name: string, max: number, suffix: string) {
    const path = process.env["PIRATE_VIRTUAL_" + name];
    const expected = process.env["PIRATE_VIRTUAL_" + name + "_SHA256"];
    assert(path && path.startsWith(join(root!, "state", "virtual-media") + "/") &&
      path.endsWith(suffix) && !path.includes("#") && !path.includes("\n") &&
      expected && /^[0-9a-f]{64}$/.test(expected) && await realpath(path) === path,
      "exact_virtual_" + name + "_selection_required");
    const info = await lstat(path);
    assert(info.isFile() && info.uid === process.getuid!() && (info.mode & 0o077) === 0 &&
      info.size > 0 && info.size <= max, "virtual_" + name + "_file_invalid");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    assert.equal(hash.digest("hex"), expected, "virtual_" + name + "_bytes_changed");
    return { path, sha256: expected, bytes: info.size };
  }
  const audio = await pinned("MIC_WAV", 64 * 1024 * 1024, ".wav");
  const video = await pinned("CAMERA_Y4M", 256 * 1024 * 1024, ".y4m");
  await writeFile(join(artifacts, "installed-virtual-media-inputs.json"),
    JSON.stringify({ source: "explicit local virtual devices", audio, video }) + "\n",
    { flag: "wx", mode: 0o600 });
  return [
    "--use-fake-device-for-media-stream",
    "--use-file-for-fake-audio-capture=" + audio.path,
    "--use-file-for-fake-video-capture=" + video.path,
  ];
}
async function openBrowser(input: Inputs, pins: string[], controlLabel: "wizard" | "application", captureArgs: string[] = []) {
  const browserControl = process.env.PIRATE_MANUAL_BROWSER_CONTROL === "disposable-loopback";
  const debugging = browserControl ? [
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--enable-automation",
  ] : [];
  assert(process.stdin.isTTY && process.stdout.isTTY, "manual_demo_requires_interactive_tty");
  assert(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, "headed_browser_display_required");
  assert.equal(digest(await readFile(input.executable)), input.executableSha256);
  const browser = await pw.chromium.launch({ executablePath: input.executable, headless: false, args: [
    "--host-resolver-rules=MAP signing.native25.test 127.0.0.1",
    "--ignore-certificate-errors-spki-list=" + pins.join(","),
    ...captureArgs,
    ...debugging,
  ] });
  input.onBrowser(browser);
  if (browserControl) {
    const session = await browser.newBrowserCDPSession();
    try {
      const { arguments: cmd } = await session.send("Browser.getBrowserCommandLine");
      const profile = cmd.find(arg => arg.startsWith("--user-data-dir="))?.slice(16);
      const tmp = process.env.TMPDIR;
      assert(profile && tmp && profile.startsWith(tmp + "/"), "browser_control_profile_outside_private_run");
      const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
      assert(/^\d{4,5}$/.test(port ?? "") && /^\/devtools\/browser\/[a-f0-9-]{36}$/.test(path ?? ""));
      await writeFile(join(input.artifacts, controlLabel + "-browser-control.json"),
        JSON.stringify({ webSocket: "ws://127.0.0.1:" + port + path, controlLabel }) + "\n",
        { flag: "wx", mode: 0o600 });
    } finally { await session.detach(); }
  }
  const stop = () => { void browser.close(); };
  input.signal.addEventListener("abort", stop, { once: true });
  return { browser, async close() { input.signal.removeEventListener("abort", stop); await browser.close(); } };
}
async function optionalJournal(path: string) {
  try { return await readPrivateJSON<Journal>(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function capture(page: Page, origin: string, artifacts: string, label: string) {
  const starts = new WeakMap<object, number>();
  let overflow = false;
  const rows: Array<{ serial: number; path: string; requestSha256: string | null;
    status: number | null; transportFailed: boolean }> = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() !== "POST" || url.origin !== origin || !url.pathname.startsWith("/api/")) return;
    if (rows.length === 256) { overflow = true; return; }
    starts.set(request, rows.length);
    rows.push({ serial: rows.length + 1, path: url.pathname,
      requestSha256: request.postData() === null ? null : digest(request.postData()!), status: null, transportFailed: false });
  });
  page.on("response", response => { const i = starts.get(response.request()); if (i !== undefined) rows[i]!.status = response.status(); });
  page.on("requestfailed", request => { const i = starts.get(request); if (i !== undefined) rows[i]!.transportFailed = true; });
  return async () => {
    await writeFile(join(artifacts, label + "-http-observations.json"), JSON.stringify({ rows, overflow,
      readiness: "NOT_INFERRED_FROM_HTTP_CAPTURE", simulatedWallet: true }) + "\n", { flag: "wx", mode: 0o600 });
    assert(!overflow, "manual_capture_bound_originals_retained_evidence_incomplete");
  };
}
export async function manualWizard(input: Inputs & { wizardOrigin: string; pairingCode: string;
  helperOrigin: string; helperCertificate: Buffer; stateRoot: string; origin: string; invitation?: string;
  approveRegistration?(): Promise<void>;
  retireHostedKeys?(): Promise<void> }) {
  const owned = await openBrowser(input, [certificatePin(input.helperCertificate)], "wizard");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const observer = new OriginalObserver();
  let saveCapture: (() => Promise<void>) | undefined, servicesPrepared = false, observation = 0;
  try {
    const context = await owned.browser.newContext(), page = await context.newPage();
    saveCapture = capture(page, input.wizardOrigin, input.artifacts, "manual-wizard");
    const originalPath = join(input.stateRoot, "wizard/web2-wizard-original.json");
    const signingPath = join(input.stateRoot, "wizard/web2-signing-sidecar.json");
    await context.exposeBinding("manualSdkFixtureSign", async (source, value: unknown) => {
      assert.equal(new URL(source.frame.url()).origin, "https://account.megaeth.com");
      const data = object(value), normalized = wire({ domain: data.domain, types: data.types,
        primaryType: data.primaryType, message: data.message ?? data.value });
      const saved = await readPrivateJSON<Journal>(originalPath);
      observer.observe(saved); assert(saved.prepared && saved.plan);
      const enrollment = enrollmentTypedData(parseEnrollment(saved.prepared.enrollment));
      if (canonical(normalized) === canonical(wire(enrollment))) return { status: "success", signature: await web2Owner.signTypedData(enrollment) };
      const signing = await readPrivateJSON<SigningJournal>(signingPath);
      const authorization = ownerAuthorizationTypedData(signing.authorization, parsePlan(saved.plan).config);
      assert.equal(canonical(normalized), canonical(wire(authorization)), "fixture_only_signs_retained_original");
      return { status: "success", signature: await web2Owner.signTypedData(authorization) };
    });
    const penpalRoot = dirname(dirname(require.resolve("penpal")));
    const penpalPackage = object(JSON.parse(await readFile(join(penpalRoot, "package.json"), "utf8")));
    const penpalEntry = object(object(penpalPackage.exports).import).default;
    assert.equal(penpalEntry, "./dist/penpal.mjs");
    const penpal = await readFile(resolve(penpalRoot, penpalEntry as string), "utf8");
    await context.route("https://account.megaeth.com/**", async route => {
      if (new URL(route.request().url()).pathname === "/fixture-penpal.mjs")
        return route.fulfill({ contentType: "text/javascript", body: penpal });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><script type="module">
        import {connect,WindowMessenger} from '/fixture-penpal.mjs';
        const account={status:'connected',network:'testnet',address:${JSON.stringify(web2Owner.address)}};
        const c=connect({messenger:new WindowMessenger({remoteWindow:parent,allowedOrigins:[${JSON.stringify(input.helperOrigin)}]}),
          methods:{status:()=>account,connect:async()=>account,signData:({data})=>window.manualSdkFixtureSign(data)}});
        const remote=await c.promise;await remote.ready();</script>` });
    });
    await page.goto(input.wizardOrigin + "/?setup=linux-web2");
    console.log("LOCAL FIXTURE: use this controlled browser, not your real MOSS wallet. Keep this terminal private.");
    console.log(JSON.stringify({ wizard: input.wizardOrigin + "/?setup=linux-web2", pairingCode: input.pairingCode,
      communityOrigin: input.origin, fixtureInvitation: input.invitation, fixtureOwner: web2Owner.address }));
    console.log(input.retireHostedKeys ?
      "Perform setup in the browser. Terminal: status | approve registration (after the held wallet return) | services (after funded) | continue (after running) | stop." :
      "Pair again and reopen the retained installation. Terminal: status | continue | stop.");
    while (true) {
      input.signal.throwIfAborted();
      const command = (await terminal.question("wizard> ", { signal: input.signal })).trim();
      if (command === "stop") throw Error("manual_operator_stop_originals_retained");
      if (command === "approve registration") {
        if (!input.approveRegistration) { console.log("The reopened run has no new approval action."); continue; }
        await input.approveRegistration();
        console.log("The disposable approval is recorded. Use the Wizard to reconcile the retained original.");
        continue;
      }
      if (!["status", "services", "continue"].includes(command)) { console.log("Use the available terminal actions."); continue; }
      const saved = await optionalJournal(originalPath), status = observer.observe(saved);
      console.log(JSON.stringify(status));
      await writeFile(join(input.artifacts, "wizard-checkpoint-" + ++observation + ".json"), JSON.stringify({
        status, journalSha256: saved ? digest(await readFile(originalPath)) : null, observedAt: new Date().toISOString(),
        runtimeAcceptance: "UNQUALIFIED_MANUAL_OBSERVATION" }) + "\n", { flag: "wx", mode: 0o600 });
      if (command === "services") {
        if (!input.retireHostedKeys) { console.log("The retained run has no new provisioning action."); continue; }
        if (servicesPrepared) { console.log("Fixture infrastructure already prepared; no effect repeated."); continue; }
        if (!saved || saved.phase !== "funded" || saved.pending !== null) { console.log("Use the existing original's Reconcile button until funded. No action sent by driver."); continue; }
        observer.services(saved);
        // An uncertain callback ends this run; it is never automatically retried.
        await input.retireHostedKeys(); servicesPrepared = true;
        console.log("Exact funded fixture infrastructure prepared. Review owner publishing in the Wizard.");
      }
      if (command !== "continue") continue;
      if (!saved || !status.mayContinue) { console.log("Installation is not observed running. Reconcile the retained original in the Wizard; no replay/reset."); continue; }
      const signing = await readPrivateJSON<SigningJournal>(signingPath);
      observer.installed(saved, signing); assert(saved.plan && saved.prepared && saved.request);
      assert.equal(saved.request.origin, input.origin); assert.equal(saved.request.controller, web2Owner.address.toLowerCase());
      assert(saved.controllerSignature && await verifyTypedData({ ...enrollmentTypedData(parseEnrollment(saved.prepared.enrollment)),
        address: web2Owner.address, signature: saved.controllerSignature }), "genuine_retained_controller_signature_required");
      assert(signing.accepted && await verifyTypedData({ ...ownerAuthorizationTypedData(signing.authorization, parsePlan(saved.plan).config),
        address: web2Owner.address, signature: signing.accepted.signature }), "genuine_retained_owner_authorization_required");
      await page.screenshot({ path: join(input.artifacts, "manual-installed-wizard.png"), fullPage: true });
      return status;
    }
  } finally { terminal.close(); browserMark("capture-save", "enter"); try { await saveCapture?.(); } finally { browserMark("capture-save", "return"); browserMark("browser-close", "enter"); try { await owned.close(); } finally { browserMark("browser-close", "return"); } } }
}

export async function manualApplication(input: Inputs & {
  origin: string; certificateFile: string; release: string;
  control(page: Page): Promise<void>;
}) {
  const captureArgs = process.env.PIRATE_MANUAL_CAPTURE_MODE === "virtual"
    ? await virtualCapture(input.artifacts) : [];
  const owned = await openBrowser(input, [certificatePin(await readFile(input.certificateFile))], "application", captureArgs);
  let saveCapture: (() => Promise<void>) | undefined;
  try {
    const context = await owned.browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
    saveCapture = capture(page, input.origin, input.artifacts, "manual-application");
    const manifest = object(JSON.parse(await readFile(join(input.release, "assets/.vite/manifest.json"), "utf8")));
    const sdk = Object.entries(manifest).find(([name]) => name.includes("@megaeth-labs/wallet-sdk")); assert(sdk);
    const path = object(sdk[1]).file;
    assert(typeof path === "string" && /^app\/assets\/[A-Za-z0-9_.-]+\.js$/.test(path), "current_live_sdk_asset_required");
    await context.exposeBinding("manualAppFixtureSign", async (source, message: unknown) => {
      assert.equal(new URL(source.frame.url()).origin, input.origin);
      assert(typeof message === "string" && message.length < 8192 && message.includes(input.origin) && message.includes("6343"));
      return web2Owner.signMessage({ message });
    });
    const module = `export const mega={async initialise(){},async connect(){return {address:${JSON.stringify(web2Owner.address)}}},
      async status(){return {address:${JSON.stringify(web2Owner.address)}}},async signMessage(message){return {status:'success',signature:await window.manualAppFixtureSign(message)}},
      async signData(){throw Error('typed application actions unavailable in this SDK fixture')}};`;
    await context.route(input.origin + "/" + path, route => route.fulfill({ status: 200, contentType: "text/javascript", body: module }));
    await page.goto(input.origin);
    console.log("Installed app opened. Use the ordinary screens to publish and practice. Login uses the explicit local SDK fixture.");
    await input.control(page);
  } finally { browserMark("capture-save", "enter"); try { await saveCapture?.(); } finally { browserMark("capture-save", "return"); browserMark("browser-close", "enter"); try { await owned.close(); } finally { browserMark("browser-close", "return"); } } }
}
