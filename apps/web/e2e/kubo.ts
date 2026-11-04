// Offline Kubo node for mirror acceptance. The image is pinned by digest; the
// daemon runs with --offline, so it never joins the public network. The CAR is
// imported with `dag import`, not added as a file, so the gateway serves the
// website root CID recorded in dist/car/car.json.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const KUBO_IMAGE = "ipfs/kubo@sha256:b293923d66e490e70ced64df42ea7a6cf7eac2740e3fb29101df18070fa7be48"; // v0.43.1
export const KUBO_CONTAINER = "pirate-web-e2e-kubo";
export const KUBO_PORT = 18080;
const carDir = fileURLToPath(new URL("../dist/car/", import.meta.url));
const initScript = fileURLToPath(new URL("./kubo-init.sh", import.meta.url));

export const rootCid = () => (JSON.parse(readFileSync(`${carDir}car.json`, "utf8")) as { rootCid: string }).rootCid;
/** Subdomain gateway origin: one origin per CID, with _redirects support. */
export const mirrorOrigin = () => `http://${rootCid()}.ipfs.localhost:${KUBO_PORT}`;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function stopKubo() {
  try { docker("rm", "-f", "-v", KUBO_CONTAINER); } catch { /* not running */ }
}

export async function startKubo() {
  stopKubo();
  // Host networking with loopback-only listeners (kubo-init.sh): bridge port
  // publishing is unreliable on the development machine.
  docker("run", "-d", "--name", KUBO_CONTAINER, "--network", "host",
    "-v", `${carDir}:/import:ro`, "-v", `${initScript}:/container-init.d/001-offline.sh:ro`,
    KUBO_IMAGE, "daemon", "--offline");
  // Commands run before the daemon holds the repo lock would take it instead,
  // so wait for the daemon's own readiness line.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const result = spawnSync("docker", ["logs", KUBO_CONTAINER], { encoding: "utf8" });
    const logs = `${result.stdout}${result.stderr}`; // Kubo logs readiness on stderr
    if (logs.includes("Daemon is ready")) break;
    if (Date.now() > deadline) throw new Error(`kubo did not start: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const imported = docker("exec", KUBO_CONTAINER, "ipfs", "dag", "import", "--pin-roots", "/import/site.car");
  if (!imported.includes(rootCid())) throw new Error(`dag import did not pin ${rootCid()}: ${imported}`);
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${KUBO_PORT}/ipfs/${rootCid()}/index.html`, { redirect: "manual" }).catch(() => undefined);
    if (response !== undefined && response.status < 500) return;
    if (Date.now() > deadline) throw new Error("kubo gateway did not answer");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
