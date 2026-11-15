// Disposable local TLS transport. It is not a public CA or application proof.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer as tcpServer } from "node:net";
import { createServer, request, type RequestOptions } from "node:https";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireOperation, hash, processIdentity } from "../../deploy/linux/backend-state.ts";
import type { PublicIngress } from "../../deploy/linux/public-ingress.ts";

const execute = promisify(execFile);
export async function availablePort() {
  const server = tcpServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return address.port;
}
export async function ingressFixture() {
  const parent = process.env.TMPDIR, executableInput = process.env.PIRATE_CADDY_BINARY,
    expected = process.env.PIRATE_CADDY_SHA256;
  assert(parent && executableInput && expected, "explicit_owned_TMPDIR_and_pinned_Caddy_required");
  const executable = await realpath(executableInput);
  assert.equal(hash(await readFile(executable)), expected, "fixture_Caddy_pin_changed");
  const root = await mkdtemp(join(await realpath(parent), "web2-ingress-"));
  for (const dir of ["control", "data", "config"]) await mkdir(join(root, dir), { mode: 0o700 });
  async function certificate(name: string) {
    const key = join(root, name + ".key"), cert = join(root, name + ".pem");
    await execute("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-nodes", "-days", "1", "-subj", "/CN=upstream.test", "-addext", "subjectAltName=DNS:upstream.test",
      "-keyout", key, "-out", cert], { timeout: 10000, maxBuffer: 65536 });
    return { key: await readFile(key), cert: await readFile(cert), path: cert };
  }
  const trusted = await certificate("trusted"), untrusted = await certificate("untrusted");
  let requests = 0;
  const upstream = createServer(trusted, (req, res) => {
    requests++; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ headers: req.headers, url: req.url }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  try {
    const address = upstream.address(); assert(address && typeof address !== "string");
    const httpsPort = await availablePort(), httpPort = await availablePort();
    const process = await processIdentity(globalThis.process.pid); assert(process);
    const lease = await acquireOperation(join(root, "control"), "ingress", "web2-ingress-fixture",
      { purpose: "actual pinned Caddy and HTTPS upstream" }, process.pidNamespace);
    const ingress: PublicIngress = { schema: "pirate.linux-public-ingress/1", origin: `https://community.test:${httpsPort}`,
      upstream: `https://127.0.0.1:${address.port}`, upstreamServerName: "upstream.test",
      upstreamCaFile: trusted.path, upstreamCaSha256: hash(trusted.cert), executable, executableSha256: expected,
      configurationFile: join(root, "config", "Caddyfile"), dataDirectory: join(root, "data"), httpPort, httpsPort,
      tls: { kind: "local-fixture-ca" } };
    const rootCertificate = join(ingress.dataDirectory, "pki", "authorities", "local", "root.crt");
    async function call(path = "/", overrides: RequestOptions = {}) {
      const ca = await readFile(rootCertificate);
      return await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: httpsPort, servername: "community.test", ca,
          headers: { Host: new URL(ingress.origin).host }, method: "GET", path, timeout: 2000, agent: false, ...overrides }, res => {
          let body = "";
          res.on("data", c => { body += c; if (body.length > 65536) req.destroy(Error("fixture_response_limit")); });
          res.once("error", reject); res.once("end", () => resolve({ status: res.statusCode!, body }));
        });
        req.once("error", reject); req.once("timeout", () => req.destroy(Error("fixture_https_timeout"))); req.end();
      });
    }
    async function ready() {
      const until = performance.now() + 8000; let last: unknown;
      do {
        try { const response = await call(); assert.equal(response.status, 200); return; }
        catch (e) { last = e; await delay(50); }
      } while (performance.now() < until);
      throw last;
    }
    const environment = { PATH: globalThis.process.env.PATH, HOME: ingress.dataDirectory,
      XDG_DATA_HOME: ingress.dataDirectory, XDG_CONFIG_HOME: ingress.dataDirectory };
    return { root, ingress, lease, call, ready, rootCertificate, requests: () => requests,
      async preflight() {
        const args = ["--config", ingress.configurationFile, "--adapter", "caddyfile"];
        const adapted = await execute(executable, ["adapt", ...args], { env: environment, timeout: 10000, maxBuffer: 1024 ** 2 });
        const validated = await execute(executable, ["validate", ...args], { env: environment, timeout: 10000, maxBuffer: 1024 ** 2 });
        await writeFile(join(root, "adapted.json"), adapted.stdout, { mode: 0o600 });
        await writeFile(join(root, "validate.log"), validated.stdout + validated.stderr, { mode: 0o600 });
      },
      replaceUpstreamTrust(good: boolean) { upstream.closeAllConnections(); upstream.setSecureContext(good ? trusted : untrusted); },
      async close() {
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) => upstream.close(e => e ? reject(e) : resolve()));
      } };
  } catch (error) {
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); throw error;
  }
}

/** Reuses the owning runtime's actual V3/Posts chain fixture after its reviewed
 * merge. Hosted JSON here is merely an untrusted hint; no RPC result is faked. */
export async function installationAuthorityFixture() {
  const { web2SongChain, web2Controller } = await import("./web2-first-song-chain.ts");
  const { hashText, hashJson } = await import("../../packages/community/common.ts");
  const { communityIpfsTransport } = await import("../../services/community-deployment-profile.ts");
  const { linuxWeb2DraftFrom } = await import("../../packages/community-setup/linux-web2-profile.ts");
  const recognition = { schema: "pirate.recognition-profile/1" as const, namespace: hashText("installation-fixture-recognition"),
    origin: "https://recognition.example", signer: web2Controller.address.toLowerCase(),
    providerBindingSha256: hashText("explicit fixture binding; no provider request") };
  const chain = await web2SongChain({ ...recognition, sha256: hashJson(recognition) });
  try {
    assert.equal(chain.enrolled.status, "consumed");
    const draft = linuxWeb2DraftFrom({ schema: "pirate.linux-web2-draft/1", name: chain.current().app.label,
      origin: chain.current().app.origin, deployment: chain.deployment, configuration: chain.current(),
      enrollment: { schema: "pirate.hosted-enrollment-status/1", enrollmentId: hashText("installed fixture enrollment"),
        communityId: chain.profile.communityId, installationId: chain.profile.installationId,
        profile: chain.deployment.directoryProfile, configurationUri: chain.original.plan.uri,
        operations: [{ kind: "registration", state: "consumed", transactionHash: chain.original.transactionHash,
          receipt: { transactionHash: chain.original.transactionHash } }] } });
    const { communityId: _community, communityKey: _key, installationId: _install, ...deployment } = draft.enrollment.profile;
    let now = BigInt(Math.floor(Date.now() / 1000));
    return { chain, draft, authority: { client: chain.client, deployment,
      send: communityIpfsTransport(draft.deployment), now: () => now, maxSafeBlockAgeSeconds: 600n,
      registrar: chain.original.plan.registrar, registrarRevision: chain.original.plan.registrarRevision },
      setNow: (value: bigint) => { now = value; }, close: chain.close };
  } catch (error) { await chain.close(); throw error; }
}
