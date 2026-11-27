import assert from "node:assert/strict";
import { constants, readFileSync } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { httpsOrigin } from "../../packages/community/manifest-core.ts";
import { canonical, exact, object } from "../../packages/community/common.ts";
import { trustedWeb2PublicationReadbackPath } from "../../packages/community/web2-trusted-publication.ts";
import { web2DanceLiveProofHeader, web2DanceLiveProofMode, type Web2DanceLiveProof } from "../../packages/community/web2-dance-live-proof.ts";
import type { PublicationMountIdentity } from "../../services/publication-installed-selection.ts";
import type { Web2CommunityConfig } from "../../packages/community/web2-config-manifest.ts";
import {
  hash,
  privateDirectory,
  privateFile,
  processIdentity,
  sameProcess,
  syncDirectory,
  type OperationLease,
} from "./backend-state.ts";

type IngressTerminal = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};
/** The original child remains reachable if native lifetime inspection itself
 * fails. This is custody for cleanup, never authority to start another child. */
export class IngressStartupFailure extends AggregateError {
  readonly custody: {
    pid: number | undefined;
    terminal: Promise<IngressTerminal>;
    stop(): Promise<IngressTerminal>;
  };
  constructor(errors: unknown[], custody: IngressStartupFailure["custody"]) {
    super(errors, "ingress_start_failed_custody_retained");
    this.custody = custody;
  }
}

export interface PublicIngress {
  schema: "pirate.linux-public-ingress/1";
  origin: string;
  upstream: string;
  upstreamServerName: string;
  upstreamCaFile: string;
  upstreamCaSha256: string;
  executable: string;
  executableSha256: string;
  configurationFile: string;
  dataDirectory: string;
  httpPort: number;
  httpsPort: number;
  tls:
    | { kind: "public-acme"; directory: string; email: string }
    | { kind: "local-fixture-ca" };
}
const absolute = (value: unknown) => {
  assert(
    typeof value === "string" &&
      isAbsolute(value) &&
      normalize(value) === value &&
      value !== "/" &&
      !/[\x00-\x1f\x7f]/.test(value),
    "canonical_ingress_path_required",
  );
  return value;
};
export function publicIngressFrom(value: unknown): PublicIngress {
  const row = object(structuredClone(value));
  exact(row, [
    "schema",
    "origin",
    "upstream",
    "upstreamServerName",
    "upstreamCaFile",
    "upstreamCaSha256",
    "executable",
    "executableSha256",
    "configurationFile",
    "dataDirectory",
    "httpPort",
    "httpsPort",
    "tls",
  ]);
  assert(row.schema === "pirate.linux-public-ingress/1");
  const origin = httpsOrigin(row.origin),
    publicUrl = new URL(origin),
    upstream = httpsOrigin(row.upstream),
    u = new URL(upstream);
  assert(
    u.hostname === "127.0.0.1" && u.port && upstream !== origin,
    "private_loopback_https_upstream_required",
  );
  assert(
    typeof row.upstreamServerName === "string" &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(row.upstreamServerName) &&
      row.upstreamServerName.length <= 253,
    "exact_upstream_tls_name_required",
  );
  const digest = (v: unknown) => {
    assert(
      typeof v === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(v),
      "explicit_ingress_pin_required",
    );
    return v;
  };
  const port = (v: unknown) => {
    assert(
      typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 65535,
    );
    return v;
  };
  const httpPort = port(row.httpPort),
    httpsPort = port(row.httpsPort);
  assert(
    httpPort !== httpsPort &&
      Number(u.port) !== httpPort &&
      Number(u.port) !== httpsPort,
    "separate_ingress_ports_required",
  );
  const t = object(row.tls);
  let tls: PublicIngress["tls"];
  if (t.kind === "public-acme") {
    exact(t, ["kind", "directory", "email"]);
    assert(typeof t.directory === "string" && typeof t.email === "string");
    const issuer = new URL(t.directory);
    assert(
      issuer.protocol === "https:" &&
        !issuer.username &&
        !issuer.password &&
        !issuer.hash &&
        !issuer.search &&
        !/[\s\\]/.test(t.directory) &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.email),
      "explicit_acme_issuer_required",
    );
    assert(
      !publicUrl.port &&
        !["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname),
      "public_dns_origin_required",
    );
    tls = { kind: t.kind, directory: t.directory, email: t.email };
  } else {
    exact(t, ["kind"]);
    assert(t.kind === "local-fixture-ca", "explicit_tls_mode_required");
    tls = { kind: t.kind };
  }
  return {
    schema: row.schema,
    origin,
    upstream,
    upstreamServerName: row.upstreamServerName,
    upstreamCaFile: absolute(row.upstreamCaFile),
    upstreamCaSha256: digest(row.upstreamCaSha256),
    executable: absolute(row.executable),
    executableSha256: digest(row.executableSha256),
    configurationFile: absolute(row.configurationFile),
    dataDirectory: absolute(row.dataDirectory),
    httpPort,
    httpsPort,
    tls,
  };
}

export function renderPublicIngress(value: unknown): string {
  const p = publicIngressFrom(value),
    q = JSON.stringify;
  const issuer =
    p.tls.kind === "public-acme"
      ? `\n  acme_ca ${q(p.tls.directory)}\n  email ${q(p.tls.email)}`
      : "";
  return `{
  admin off
  persist_config off
${p.tls.kind === "local-fixture-ca" ? "  default_bind 127.0.0.1\n" : ""}  skip_install_trust
  grace_period 5s
  http_port ${p.httpPort}
  https_port ${p.httpsPort}
  storage file_system ${q(p.dataDirectory)}
  servers {
    strict_sni_host on
  }
${issuer}
}
${q(p.origin)} {
${p.tls.kind === "local-fixture-ca" ? "  tls internal\n" : ""}  @private path /_operator /_operator/*
  handle @private {
    respond 404
  }
  handle {
    reverse_proxy ${q(p.upstream)} {
      header_up Host ${q(new URL(p.origin).host)}
      header_up -Forwarded
      header_up -X-Forwarded-*
      header_up -CF-Connecting-IP
      header_up -X-Pirate-Native-Request
      header_up -X-Pirate-Readback-Key
      header_up -X-Pirate-Private-Forwarder
      transport http {
        tls_trust_pool file ${q(p.upstreamCaFile)}
        tls_server_name ${q(p.upstreamServerName)}
      }
    }
  }
}
`;
}

/** Exact retained configuration; an existing file is re-synced, never replaced. */
export async function retainPublicIngress(
  value: unknown,
  lease: OperationLease,
) {
  const p = publicIngressFrom(value),
    bytes = Buffer.from(renderPublicIngress(p));
  await lease.assertHeld();
  await privateDirectory(p.dataDirectory);
  await privateDirectory(dirname(p.configurationFile));
  assert(
    (await realpath(p.upstreamCaFile)) === p.upstreamCaFile &&
      hash(await readFile(p.upstreamCaFile)) === p.upstreamCaSha256,
    "ingress_upstream_trust_changed",
  );
  let file;
  try {
    file = await open(
      p.configurationFile,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(p.configurationFile);
    assert(
      info.isFile() &&
        info.nlink === 1 &&
        !(info.mode & 0o077) &&
        info.uid === process.getuid!(),
    );
    file = await open(
      p.configurationFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      assert(
        (await file.readFile()).equals(bytes),
        "original_ingress_configuration_changed",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(dirname(p.configurationFile));
    await lease.assertHeld();
    return { configurationFile: p.configurationFile, sha256: hash(bytes) };
  }
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(p.configurationFile));
  await lease.assertHeld();
  return { configurationFile: p.configurationFile, sha256: hash(bytes) };
}

/** Foreground child of the actual installer/service owner. No detached daemon,
 * systemd mutation, root privilege change or automatic restart is performed. */
export async function startPublicIngress(
  value: unknown,
  lease: OperationLease,
  assertCurrent: () => Promise<void>,
) {
  const p = publicIngressFrom(value);
  await retainPublicIngress(p, lease);
  assert(
    (await realpath(p.executable)) === p.executable &&
      hash(await readFile(p.executable)) === p.executableSha256,
    "ingress_binary_changed",
  );
  await assertCurrent();
  await lease.assertHeld();
  await lease.record("public-ingress-start-intent", {
    executableSha256: p.executableSha256,
    origin: p.origin,
    configurationSha256: hash(renderPublicIngress(p)),
    tlsMode: p.tls.kind,
  });
  await assertCurrent();
  const child = spawn(
    p.executable,
    ["run", "--config", p.configurationFile, "--adapter", "caddyfile"],
    {
      cwd: p.dataDirectory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: p.dataDirectory,
        XDG_DATA_HOME: p.dataDirectory,
        XDG_CONFIG_HOME: p.dataDirectory,
        TZ: "UTC",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  // Capture errors without an unhandled rejection while startup is journalling.
  const terminal = new Promise<IngressTerminal>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) =>
      resolve({ code: null, signal: null, error }),
    );
  });
  let identity: Awaited<ReturnType<typeof processIdentity>> = null;
  let birth: { pid: number; start: string; parent: number } | undefined;
  function childLifetime() {
    assert(child.pid, "ingress_child_pid_unavailable");
    const raw = readFileSync(`/proc/${child.pid}/stat`, "utf8"),
      fields = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/);
    return { pid: child.pid, start: fields[19]!, parent: Number(fields[1]) };
  }
  function assertOwnedChild() {
    assert(
      birth && birth.parent === process.pid,
      "ingress_birth_unavailable_custody_retained",
    );
    assert.deepEqual(
      childLifetime(),
      birth,
      "ingress_process_changed_custody_retained",
    );
  }
  async function stopOwned() {
    if (child.exitCode !== null || child.signalCode !== null)
      return await terminal;
    assertOwnedChild();
    child.kill("SIGTERM");
    const graceful = await Promise.race([
      terminal,
      delay(7000, null, { ref: false }),
    ]);
    if (graceful) return graceful;
    // A failed graceful stop never authorizes signalling a reused or foreign PID.
    assertOwnedChild();
    child.kill("SIGKILL");
    const killed = await Promise.race([
      terminal,
      delay(3000, null, { ref: false }),
    ]);
    assert(killed, "ingress_terminal_unavailable_custody_retained");
    return killed;
  }
  try {
    await once(child, "spawn");
    // Capture kernel parent/start-time synchronously before the first awaited
    // namespace observation; failure of that richer read cannot lose custody.
    birth = childLifetime();
    assert.equal(birth.parent, process.pid);
    identity = await processIdentity(child.pid!);
    assert(identity, "ingress_child_identity_unavailable_custody_retained");
    assert.equal(identity.hostStartTicks, birth.start);
    assertOwnedChild();
    await lease.record("public-ingress-process", {
      identity,
      configurationSha256: hash(renderPublicIngress(p)),
    });
    await assertCurrent();
    await lease.assertHeld();
    assert(
      child.exitCode === null && child.signalCode === null,
      "ingress_start_failed",
    );
  } catch (error) {
    // Start intent stays durable on every failure. Clean only the child whose
    // actual lifetime was observed; uncertainty is retained, never retried here.
    try {
      if (birth) await stopOwned();
      else
        assert(
          !child.pid || child.exitCode !== null || child.signalCode !== null,
          "ingress_identity_unavailable_custody_retained",
        );
    } catch (cleanup) {
      throw new IngressStartupFailure([error, cleanup], {
        pid: child.pid,
        terminal,
        stop: stopOwned,
      });
    }
    throw error;
  }
  const captured = identity;
  return {
    identity,
    terminal,
    async stop() {
      // Cleanup reduces our own child's authority even if the operation lease
      // was lost. Captured process identity remains mandatory; no lease release.
      const result = await stopOwned();
      assert(
        captured && (await processIdentity(captured.hostPid)) === null,
        "ingress_still_present",
      );
      if (result.error) throw result.error;
      return result; // Terminal outcome is separate from proven process absence.
    },
  };
}

/** A real application response over verified upstream TLS, not a readiness flag. */
class ApplicationBootPending extends Error {}

/** Read-only startup wait. No create/start, journal replacement or TLS fallback.
 * Only a not-yet-listening connection, timeout or explicit503 can be retried. */
export async function waitForCommunityIngress(
  ingress: PublicIngress,
  expectedCommunityId: string,
  assertCurrent: () => Promise<void>,
  assertReady: () => Promise<void> = assertCurrent,
) {
  const signal = AbortSignal.timeout(60000);
  for (;;) {
    signal.throwIfAborted();
    await assertCurrent();
    signal.throwIfAborted();
    try {
      await inspectCommunityIngress(ingress, expectedCommunityId, false, signal);
    } catch (error) {
      const notListening = error instanceof Error && "code" in error &&
        ["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(String(error.code));
      if (!(error instanceof ApplicationBootPending) && !notListening) throw error;
      await delay(250, undefined, { signal });
      continue;
    }
    await assertReady();
    signal.throwIfAborted();
    return;
  }
}

export async function inspectCommunityIngress(
  ingress: PublicIngress,
  expectedCommunityId: string,
  throughIngress = false,
  signal?: AbortSignal,
) {
  const actual = await readApplicationIngress(ingress, "/api/public/community", throughIngress, signal);
  assert(
    actual && typeof actual === "object" && "communityId" in actual && actual.communityId === expectedCommunityId,
    "actual_application_community_changed",
  );
}

/** The public summary does not identify the serving configuration. Read the
 * complete application document through the owned ACME ingress. */
export async function inspectTrustedRevisionOneIngress(ingress: PublicIngress, original: Web2CommunityConfig) {
  assert(ingress.tls.kind === "public-acme" && original.configurationRevision === 1,
    "trusted_revision_two_original_acme_readback_required");
  const actual = await readApplicationIngress(
    ingress, "/.well-known/pirate-community.json", true, AbortSignal.timeout(5000),
  );
  assert(canonical(actual) === canonical(original), "trusted_revision_two_original_served_configuration_changed");
}

type TrustedPublicationLiveProof = {
  mount: PublicationMountIdentity;
  active: string;
  dance?: Web2DanceLiveProof;
};

/** Confirm this live, authenticated private Workerd edge loaded the original
 * selection. No proof file, public summary or localhost fallback is enough. */
export async function inspectTrustedPublicationIngress(
  ingress: PublicIngress,
  readbackKeyFile: string,
  expected: TrustedPublicationLiveProof,
) {
  assert(ingress.tls.kind === "public-acme", "trusted_web2_publication_private_readback_required");
  const file = await privateFile(readbackKeyFile, 64);
  let key: string;
  try {
    const bytes = Buffer.alloc(65);
    try {
      const read = await file.read(bytes, 0, bytes.length, 0);
      assert(read.bytesRead === 64 && (await file.stat()).size === 64, "trusted_web2_publication_readback_key_changed");
      key = bytes.subarray(0, 64).toString("latin1");
      assert(/^[a-f0-9]{64}(?![\s\S])/.test(key), "trusted_web2_publication_readback_key_changed");
    } finally { bytes.fill(0); }
  } finally {
    await file.close();
  }
  await readApplicationIngress(ingress, trustedWeb2PublicationReadbackPath, false,
    AbortSignal.timeout(5000), { key, expected });
}

async function readApplicationIngress(
  ingress: PublicIngress,
  path: "/api/public/community" | "/.well-known/pirate-community.json" | typeof trustedWeb2PublicationReadbackPath,
  throughIngress: boolean,
  signal?: AbortSignal,
  publication?: { key: string; expected: TrustedPublicationLiveProof },
) {
  const bytes = throughIngress
    ? ingress.tls.kind === "local-fixture-ca"
      ? await readFile(
          join(
            ingress.dataDirectory,
            "pki",
            "authorities",
            "local",
            "root.crt",
          ),
        )
      : undefined
    : await readFile(ingress.upstreamCaFile);
  const url = new URL(ingress.upstream);
  const verifyServedConfig = path === "/.well-known/pirate-community.json";
  if (publication) assert(path === trustedWeb2PublicationReadbackPath && !throughIngress && bytes &&
    hash(bytes) === ingress.upstreamCaSha256, "trusted_web2_publication_readback_ca_changed");
  return await new Promise<unknown>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: throughIngress ? ingress.httpsPort : Number(url.port),
        servername: throughIngress
          ? new URL(ingress.origin).hostname
          : ingress.upstreamServerName,
        ca: bytes,
        method: "GET",
        path,
        ...(verifyServedConfig || publication ? { rejectUnauthorized: true } : {}),
        ...(publication ? { agent: false as const } : {}),
        headers: { Host: new URL(ingress.origin).host,
          ...(publication ? { "X-Pirate-Readback-Key": publication.key } : {}),
          ...(publication?.expected.dance ?
            { [web2DanceLiveProofHeader]: web2DanceLiveProofMode(publication.expected.dance) } : {}),
        },
        timeout: 5000,
        signal,
      },
      (res) => {
        const decoder = new TextDecoder("utf-8", { fatal: verifyServedConfig || Boolean(publication), ignoreBOM: true });
        let body = "";
        const append = (text: string) => {
          assert(body.length + text.length <= 65536, "application_readback_limit");
          body += text;
        };
        res.on("data", (chunk: Buffer) => {
          try {
            append(decoder.decode(chunk, { stream: true }));
          } catch (error) {
            reject(error);
            req.destroy();
          }
        });
        res.once("error", reject);
        res.once("end", () => {
          try {
            if (res.statusCode === 503) throw new ApplicationBootPending("application_boot_pending");
            assert(res.statusCode === 200, "application_readback_unavailable");
            append(decoder.decode());
            const value: unknown = JSON.parse(body);
            if (publication) {
              const bootId = res.headers["x-pirate-native-boot-id"];
              assert(typeof bootId === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(bootId) &&
                res.headers["content-type"] === "application/json" && canonical(value) === canonical(publication.expected),
                "trusted_web2_publication_live_selection_changed");
            }
            resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.once("error", reject);
    req.once("timeout", () =>
      req.destroy(new ApplicationBootPending("application_readback_timeout")),
    );
    req.end();
  });
}
