#!/usr/bin/env node
/** Installed Web2 process owner. No default profile, HNS adapter or shell. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { createPublicClient, http } from "viem";
import {
  canonicalDigest,
  readPrivateJSON,
  verifyRecord,
  type SignedRecord,
  type TrustAnchor,
} from "./installed-records.ts";
import {
  verifyInstalledRelease,
  type FullRelease,
} from "./installed-release.ts";
import { createBootDirectory } from "./local-installation.ts";
import {
  hash,
  privateDirectory,
  processIdentity,
  sameProcess,
  syncDirectory,
} from "./backend-state.ts";
import { renderFullNativeConfig } from "./full-native-config.ts";
import { assertStartAllowed } from "./maintenance-guard.ts";
import {
  authenticateWeb2Enrollment,
  readWeb2HostAdmission,
  type Web2ChainAuthority,
  type Web2InstallPlan,
} from "./web2-profile-authority.ts";
import {
  web2NativeOriginal,
  web2ApplicationReleaseBody,
  type Web2NativeOriginal,
} from "../../packages/community/web2-native-business-binding.ts";
import { communityIpfsTransport } from "../../services/community-deployment-profile.ts";
import { setTimeout as delay } from "node:timers/promises";
import { nativePublicationPaths, publicationMountFor, type Web2NativePublicationInitialization,
  type Web2NativePublicationMount } from "./web2-publication-selection.ts";
import { readNativePostsRole } from "./web2-native-posts-role.ts";
import { readApprovedExpandedPublication } from "./web2-expanded-publication.ts";

export interface Web2LaunchConfiguration {
  schema: "pirate.linux-web2-launch/1";
  release: SignedRecord<FullRelease>;
  applicationRelease: Web2NativeOriginal["release"];
  trust: TrustAnchor;
  currentAdmissionFile: string;
  minimumGeneration: number;
  privateRuntimeDirectory: string;
  maintenanceDirectory: string;
}
async function writeExclusive(path: string, value: string) {
  const file = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function privateReady(socketPath: string) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = request(
          { socketPath, path: "/initialize", method: "POST", timeout: 2000 },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += String(chunk);
              if (body.length > 65536)
                req.destroy(Error("web2_initialize_response_limit"));
            });
            res.once("error", reject);
            res.once("end", () => {
              try {
                assert(res.statusCode === 200);
                resolve(JSON.parse(body));
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        req.once("error", reject);
        req.once("timeout", () =>
          req.destroy(Error("web2_initialize_request_timeout")),
        );
        req.end();
      });
    } catch (error) {
      // Retry only absence before listener creation; failed initialization is terminal.
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function runWeb2Native(configPath: string) {
  const config = await readPrivateJSON<Web2LaunchConfiguration>(
    configPath,
    16 * 1024 ** 2,
  );
  assert(config.schema === "pirate.linux-web2-launch/1");
  assert.deepEqual(Object.keys(config).sort(), [
    "applicationRelease",
    "currentAdmissionFile",
    "maintenanceDirectory",
    "minimumGeneration",
    "privateRuntimeDirectory",
    "release",
    "schema",
    "trust",
  ]);
  const release = await verifyInstalledRelease(config.release, config.trust),
    graph = release.graph;
  assert(
    release.schema === "pirate.complete-linux-web2-release/1",
    "web2_release_required",
  );
  const signed = await readPrivateJSON<SignedRecord<Web2InstallPlan>>(
    join(graph.stateRoots.configuration!, "web2-original.json"),
  );
  const original: Web2NativeOriginal = {
    schema: "pirate.web2-native-application-original/1",
    record: signed,
    release: config.applicationRelease,
    trust: config.trust,
    durableScope: graph.durableScope,
  };
  assert(
    canonicalDigest(config.applicationRelease.body) ===
      canonicalDigest(web2ApplicationReleaseBody(release)),
    "application_release_identity_changed",
  );
  await web2NativeOriginal(JSON.stringify(original));
  const plan = original.record.body,
    deployment = plan.draft.deployment;
  const publication = graph.nativePublication;
  const publicationFiles = publication ? nativePublicationPaths(publication.directory) : undefined;
  const postsRole = graph.secretBindings.find(binding => binding.name === "POSTS_CUSTODY_HOST_AUTH");
  async function publicationMount() {
    if (!publication || !publicationFiles) return undefined;
    const files = publicationFiles;
    const [initialization, selector] = await Promise.all([
      readPrivateJSON<Web2NativePublicationInitialization>(files.initialization, 5 * 1024 ** 2),
      readPrivateJSON<SignedRecord<Web2NativePublicationMount>>(files.selector),
    ]);
    const body = verifyRecord(selector, config.trust);
    assert(initialization.schema === "pirate.web2-native-publication-initialization/1" &&
      canonicalDigest(initialization.selector) === canonicalDigest(selector) &&
      canonicalDigest(body) === canonicalDigest(publicationMountFor(original, initialization.selection, publication)),
      "native_publication_launch_original_changed");
    return body.mount.selectionSha256;
  }
  const publicationSha256 = await publicationMount();
  const {
    communityId: _id,
    communityKey: _key,
    installationId: _installation,
    ...directory
  } = deployment.directoryProfile;
  // The same explicit signed qualification mapping must reach Node's pre-start
  // RPC/content reads as well as Worker egress. Container loopback is not the
  // host fixture. Production graphs have no mapping and keep normal fetch.
  const send: typeof fetch = (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    if (!graph.fixtureTransport) return fetch(request);
    const route = graph.fixtureTransport.routes.find(
      (row) => row.origin === url.origin,
    );
    assert(
      route && graph.allowedOrigins.includes(url.origin),
      "unconfigured_native_fixture_origin",
    );
    return fetch(
      new Request(route.upstream + url.pathname + url.search, request),
      { redirect: "manual" },
    );
  };
  const client = createPublicClient({
    transport: http(deployment.rpcUrl, { retryCount: 0, fetchFn: send }),
  });
  const current = async () => {
    await assertStartAllowed(config.maintenanceDirectory);
    await verifyInstalledRelease(config.release, config.trust);
    const admission = () =>
      readWeb2HostAdmission({
        path: config.currentAdmissionFile,
        trust: config.trust,
        now: Date.now,
        installationId: plan.installationId,
        draft: plan.draft,
        releaseArtifactDigest: release.artifactDigest,
        targetDigest: plan.targetDigest,
        hostFingerprint: plan.hostFingerprint,
        minimumGeneration: Math.max(config.minimumGeneration, plan.generation),
        planId: plan.planId,
      });
    await admission();
    const chain: Web2ChainAuthority = {
        client,
        send: communityIpfsTransport(deployment, send),
        now: () => BigInt(Math.floor(Date.now() / 1000)),
        maxSafeBlockAgeSeconds: BigInt(
          plan.registrationAuthority.maxSafeBlockAgeSeconds,
        ),
        deployment: directory,
        registrar: plan.registrationAuthority.registrar,
        registrarRevision: BigInt(plan.registrationAuthority.registrarRevision),
    };
    if (postsRole) await readNativePostsRole(postsRole.path, publicationFiles);
    if (graph.publicationExpansion !== undefined) {
      const approved = await readApprovedExpandedPublication({ graph, original, chain });
      assert(approved.selectionSha256 === await publicationMount(), "native_expanded_publication_selection_changed");
      const confirmed = await readApprovedExpandedPublication({ graph, original, chain });
      assert(confirmed.selectionSha256 === approved.selectionSha256, "native_expanded_publication_selection_changed");
    } else await authenticateWeb2Enrollment(chain, plan.draft);
    await admission();
  };
  await current();
  for (const root of Object.values(graph.stateRoots))
    await privateDirectory(root);
  const scratch = await createBootDirectory(config.privateRuntimeDirectory);
  const nativeOriginalFile = join(scratch, "web2-original.json");
  await writeExclusive(nativeOriginalFile, JSON.stringify(original) + "\n");
  await syncDirectory(scratch);
  const executable = join(release.root, "workerd");
  assert(
    (await realpath(executable)) === executable &&
      hash(await readFile(executable)) === release.files.workerd,
    "web2_native_binary_changed",
  );
  let stopped = false,
    active: { stop(): Promise<void>; absent(): boolean } | undefined,
    custodyCleared: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    const owner = active;
    void owner?.stop().then(
      () => custodyCleared?.(),
      () => {
        process.exitCode = 1;
        if (owner.absent()) {
          custodyCleared?.();
          return;
        }
        process.stderr.write(
          "Native process custody remains held; correct the failure before signalling cleanup again.\n",
        );
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  async function phase(mode: "initialize" | "serve") {
    assert(!stopped, "web2_native_cancelled");
    await current();
    assert(await publicationMount() === publicationSha256, "native_publication_launch_selection_changed");
    const bootId = randomBytes(32).toString("hex"),
      socket = join(scratch, mode + ".sock");
    const file = join(scratch, mode + ".capnp");
    await writeExclusive(
      file,
      renderFullNativeConfig(graph, mode, bootId, nativeOriginalFile, socket),
    );
    await syncDirectory(scratch);
    await current();
    assert(!stopped, "web2_native_cancelled");
    // The signed graph uses absolute schema/module paths. Cap'n Proto resolves
    // leading-slash imports against an explicit import root, not the host root.
    const child = spawn(executable, ["serve", "--experimental", "--import-path", "/", file], {
      cwd: release.root,
      env: { PATH: "/usr/bin:/bin", TZ: "UTC" },
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    const terminal = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (error) =>
        resolve({ code: null, signal: null, error }),
      );
    });
    let birth: { pid: number; start: string; parent: number } | undefined;
    const lifetime = () => {
      assert(child.pid, "native_child_pid_unavailable");
      const raw = readFileSync(`/proc/${child.pid}/stat`, "utf8"),
        fields = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/);
      return { pid: child.pid, start: fields[19]!, parent: Number(fields[1]) };
    };
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        try {
          birth = lifetime();
          assert.equal(birth.parent, process.pid);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    void spawned.catch(() => undefined);
    const owned = () => {
      assert(
        birth && birth.parent === process.pid,
        "native_birth_unavailable_custody_retained",
      );
      assert.deepEqual(lifetime(), birth, "native_process_identity_changed");
    };
    let stopping: Promise<void> | undefined,
      custodyAbsent = false;
    const owner = {
      absent: () => custodyAbsent,
      stop() {
        if (stopping) return stopping;
        stopping = (async () => {
          if (child.exitCode === null && child.signalCode === null) {
            await Promise.race([
              spawned,
              delay(3000, undefined, { ref: false }).then(() => {
                throw Error("native_spawn_unknown_custody_retained");
              }),
            ]);
            owned();
            child.kill("SIGTERM");
            const graceful = await Promise.race([
              terminal,
              delay(10000, null, { ref: false }),
            ]);
            if (!graceful) {
              owned();
              child.kill("SIGKILL");
            }
          }
          const result = await Promise.race([
            terminal,
            delay(3000, null, { ref: false }),
          ]);
          assert(result, "native_terminal_unknown_custody_retained");
          if (!child.pid && result.error) {
            custodyAbsent = true;
            throw result.error;
          }
          assert(
            child.pid && (await processIdentity(child.pid)) === null,
            "web2_native_lifetime_remains",
          );
          custodyAbsent = true;
          if (result.error) throw result.error;
          assert(
            result.code === 0 && result.signal === null,
            "web2_native_unclean_exit",
          );
        })().catch((error) => {
          stopping = undefined;
          throw error;
        });
        return stopping;
      },
    };
    // Ownership is reachable before any asynchronous identity or disk read.
    active = owner;
    try {
      await spawned;
      const identity = await processIdentity(child.pid!);
      assert(identity && birth, "actual_native_process_unavailable");
      assert.equal(identity.hostStartTicks, birth.start);
      owned();
      await writeExclusive(
        join(scratch, mode + "-process.json"),
        JSON.stringify(identity) + "\n",
      );
      const reply = await privateReady(socket);
      assert(
        reply.initialized === true &&
          (mode === "initialize" ? reply.publicationSelectionSha256 === publicationSha256 : reply.bootId === bootId),
        "actual_web2_startup_required",
      );
      await current();
      assert(await publicationMount() === publicationSha256, "native_publication_launch_selection_changed");
      await writeExclusive(
        join(scratch, mode + "-readback.json"),
        JSON.stringify({
          installationId: plan.installationId,
          planDigest: canonicalDigest(plan),
          artifactDigest: release.artifactDigest,
          reply,
        }) + "\n",
      );
      await syncDirectory(scratch);
      if (mode === "serve") {
        const result = await terminal;
        assert(
          stopped && result.code === 0 && result.signal === null,
          "unexpected_web2_native_exit",
        );
      }
    } finally {
      try {
        await owner.stop();
      } finally {
        if (custodyAbsent) active = undefined;
      }
    }
  }
  try {
    // The real idempotent initializer checks the retained ledger/original on every
    // boot before queue/scheduler ingress opens. It does not reset application data.
    await phase("initialize");
    await phase("serve");
  } catch (error) {
    if (active) {
      // Keep the actual owner reachable on uncertain cleanup. No fresh process,
      // adoption, automatic retry or false terminal proof follows this failure.
      process.exitCode = 1;
      process.stderr.write(
        "Native launcher retains unresolved child custody; signal this same owner after correcting the failure.\n",
      );
      const hold = setInterval(() => {}, 60000);
      try {
        await new Promise<void>((resolve) => {
          custodyCleared = resolve;
        });
      } finally {
        clearInterval(hold);
      }
    }
    throw error;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert(process.argv.length === 3, "exact_web2_launch_configuration_required");
  await runWeb2Native(process.argv[2]!);
}
