import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Import the real stack without executing a plan or contacting providers.
process.env.COMMUNITY_SLUG = "runtime-fixture";
await import("../infra/alchemy.run.ts");
await import("@effect/platform-node/NodeFileSystem");
const operatorHelp = await promisify(execFile)(
  process.execPath,
  ["--import", "tsx", "server/start-operator.ts", "--help"],
  { env: { PATH: process.env.PATH }, timeout: 15000, maxBuffer: 16384 },
);
assert.match(operatorHelp.stdout, /Usage: npm run start:operator/);
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const address = probe.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const directory = await mkdtemp(join(tmpdir(), "wizard-runtime-smoke-"));
const child = spawn(process.execPath, ["--import", "tsx", "server/start.ts"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    PATH: process.env.PATH,
    PIRATE_WIZARD_PORT: String(port),
    PIRATE_WIZARD_STATE_DIR: directory,
    INFISICAL_CLIENT_ID: "",
    INFISICAL_CLIENT_SECRET: "",
    CLOUDFLARE_API_TOKEN: "",
    PIRATE_WIZARD_STATE_PASSWORD: "",
  },
});
let output = "";
child.stdout.on("data", (chunk) => {
  output = (output + chunk).slice(-4096);
});
child.stderr.on("data", (chunk) => {
  output = (output + chunk).slice(-4096);
});
let closed = false;
const stopped = new Promise<void>((resolve) =>
  child.once("close", () => {
    closed = true;
    resolve();
  }),
);
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (closed) throw new Error(`Runner exited before readiness: ${output}`);
    let response: Response | undefined;
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/state`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch {}
    if (response?.ok) {
      const body = await response.json();
      assert.equal(body.deployment, "not_started");
      assert.equal(body.capabilities.cloudflare, false);
      ready = true;
      break;
    }
    await delay(100);
  }
  assert.ok(ready, `Runner did not become ready: ${output}`);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  console.log(
    "Runtime stack imports, operator launcher help, loopback runner and built UI passed without provider credentials.",
  );
} finally {
  if (!closed) child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (!closed) child.kill("SIGKILL");
  }, 5000);
  await stopped;
  clearTimeout(killTimer);
  await rm(directory, { recursive: true, force: true });
}
