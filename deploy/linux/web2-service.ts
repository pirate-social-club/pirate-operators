#!/usr/bin/env node
/** Explicit persistent host-service entrypoint. Closing the paired setup is
 * separate from stopping this service. No detach, systemd mutation or adoption. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import {
  canonicalDigest,
  readPrivateJSON,
  type SignedRecord,
  type TrustAnchor,
} from "./installed-records.ts";
import {
  verifyWeb2BootstrapRelease,
  installedExecutionPaths,
  type Web2BootstrapRelease,
} from "./installed-release.ts";
import { privateDirectory } from "./backend-state.ts";
import {
  startPairedOperator,
  PairedOperatorStartupFailure,
  type PairedOperatorRuntime,
  type PairedOperatorInputs,
} from "./bootstrap-local-target.ts";
import {
  forwardingOutput,
  sshForwardingHint,
} from "./operator-forwarding.ts";
import { linuxCreateRuntimeProfileFrom } from "./create-runtime-profile.ts";
import {
  linuxWeb2DraftFrom,
  type LinuxWeb2Installation,
} from "../../packages/community-setup/linux-web2-profile.ts";
import {
  createWeb2Installation,
  type Web2InstalledService,
} from "./web2-local-installation.ts";
import {
  createWeb2RuntimeBinder,
  type Web2RuntimeBindingInputs,
} from "./web2-runtime-binding.ts";

export interface Web2LocalInstallationConfiguration {
  schema: "pirate.web2-local-installation/1";
  release: SignedRecord<Web2BootstrapRelease>;
  trust: TrustAnchor;
  runtimeProfileFile: string;
}
/** W1 supplies the Wizard implementation; this module owns the paired transport. */
export interface Web2BootstrapInputs {
  binding: Web2RuntimeBindingInputs;
  /** Release only the foreground control lock after its listeners have stopped.
   * Persistent containers and whole-writer backup barriers remain untouched. */
  closeControl(): Promise<void>;
  createWizard(input: {
    directory: string;
    dist: string;
    installation: LinuxWeb2Installation;
    authorization: Parameters<PairedOperatorInputs["createRuntime"]>[0];
  }): Promise<PairedOperatorRuntime>;
}
/** The public four-method port is available before enrollment exists. Only its
 * prepare method may bind the real persisted enrollment to a strict runtime. */
export async function createWeb2BootstrapInstallation(
  inputs: Web2RuntimeBindingInputs,
  signal?: AbortSignal,
) {
  const binder = await createWeb2RuntimeBinder(inputs);
  let installation: Web2InstalledService | undefined,
    closed = false,
    busy = false;
  let idle = Promise.resolve(),
    finish: () => void = () => {};
  async function exclusive<T>(action: () => Promise<T>) {
    assert(!closed && !signal?.aborted && !busy, "web2_setup_closed_or_busy");
    busy = true;
    idle = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      return await action();
    } finally {
      busy = false;
      finish();
    }
  }
  const port: LinuxWeb2Installation = {
    prepare: (value) =>
      exclusive(async () => {
        const draft = linuxWeb2DraftFrom(value);
        const host = await binder.bind(draft);
        installation ??= await createWeb2Installation(host, signal);
        return installation.prepare(draft);
      }),
    apply: (selection) =>
      exclusive(async () => {
        assert(installation, "original_web2_runtime_unavailable");
        assert(await binder.retained(),"original_web2_runtime_unavailable");
        return installation.apply(selection);
      }),
    status: (selection) =>
      exclusive(async () => {
        assert(installation, "original_web2_runtime_unavailable");
        assert(await binder.retained(),"original_web2_runtime_unavailable");
        return installation.status(selection);
      }),
    async close() {
      assert(!busy, "web2_setup_operation_not_quiescent");
      closed = true;
      await installation?.close();
    },
  };
  return {
    port,
    async resumeOriginal() {
      const host = await binder.retained();
      if (host) {
        installation = await createWeb2Installation(host, signal);
        await installation.resumeOriginal();
      }
    },
    async shutdownService() {
      closed = true;
      await idle;
      await installation?.shutdownService();
    },
  };
}
export class Web2ServiceStartupFailure extends AggregateError {
  readonly shutdownService: () => Promise<void>;
  constructor(errors: unknown[], shutdownService: () => Promise<void>) {
    super(errors, "web2_service_startup_custody_retained");
    this.shutdownService = shutdownService;
  }
}
export async function launchWeb2LocalInstallation(
  config: Web2LocalInstallationConfiguration,
  signal?: AbortSignal,
) {
  assert(config.schema === "pirate.web2-local-installation/1");
  assert.deepEqual(Object.keys(config).sort(), [
    "release",
    "runtimeProfileFile",
    "schema",
    "trust",
  ]);
  const release = await verifyWeb2BootstrapRelease(
    config.release,
    config.trust,
  );
  const selected = await readPrivateJSON<Record<string, unknown>>(
    config.runtimeProfileFile,
  );
  assert(
    selected.schema === "pirate.linux-web2-runtime/1",
    "explicit_web2_launch_selection_required",
  );
  // Reuse only the unsigned path/port validator. This does not convert a
  // community profile, Directory identity, authority proof or old journal.
  const runtime = linuxCreateRuntimeProfileFrom({
    ...selected,
    schema: "pirate.linux-create-runtime/1",
  });
  const execution = installedExecutionPaths(release);
  assert(
    runtime.backendConfigurationFile === execution.backend,
    "create_runtime_backend_changed",
  );
  for (const path of [runtime.wizardDirectory, runtime.pairingNonceDirectory]) {
    const rel = relative(release.root, path);
    assert(
      rel === ".." || rel.startsWith("../") || isAbsolute(rel),
      "mutable_operator_state_outside_release_required",
    );
  }
  assert(
    process.version === release.execution.nodeVersion &&
      (await realpath(process.execPath)) === execution.node,
    "installed_web2_node_required",
  );
  assert.deepEqual(
    process.execArgv,
    ["--import", execution.loader],
    "installed_web2_loader_required",
  );
  assert(
    !process.env.NODE_PATH && !process.env.NODE_OPTIONS,
    "ambient_node_loader_refused",
  );
  for (const path of [runtime.wizardDirectory, runtime.pairingNonceDirectory])
    await privateDirectory(path);
  const loaded: { createWeb2BootstrapInputs(): Promise<Web2BootstrapInputs> } =
    await import(pathToFileURL(execution.backend).href);
  assert(
    typeof loaded.createWeb2BootstrapInputs === "function",
    "genuine_web2_installed_backend_required",
  );
  const inputs = await loaded.createWeb2BootstrapInputs();
  assert(
    canonicalDigest(inputs.binding.bootstrap) ===
      canonicalDigest(config.release) &&
      canonicalDigest(inputs.binding.trust) === canonicalDigest(config.trust) &&
      inputs.binding.lease.installationId === runtime.installationId,
    "installed_web2_backend_changed",
  );
  assert.deepEqual(
    await readPrivateJSON(config.runtimeProfileFile),
    selected,
    "web2_launch_selection_changed",
  );
  await verifyWeb2BootstrapRelease(config.release, config.trust);
  const installation = await createWeb2BootstrapInstallation(
      inputs.binding,
      signal,
    ),
    secret = randomBytes(32);
  try {
    await installation.resumeOriginal();
    const paired = await startPairedOperator({
      installationId: runtime.installationId,
      frontPort: runtime.frontPort,
      innerPort: runtime.innerPort,
      setup: "linux-web2",
      pairingSecret: secret,
      pairingNonceDirectory: runtime.pairingNonceDirectory,
      assertHeld: () => inputs.binding.lease.assertHeld(),
      createRuntime: (authorization) =>
        inputs.createWizard({
          directory: runtime.wizardDirectory,
          dist: execution.wizardDist,
          installation: installation.port,
          authorization,
        }),
    });
    const pairingCode = secret.toString("base64url");
    secret.fill(0);
    let setupClose: Promise<void> | undefined,
      serviceStop: Promise<void> | undefined;
    const closeSetup = () =>
      (setupClose ??= paired
        .close(() => installation.port.close())
        .catch((error) => {
          setupClose = undefined;
          throw error;
        }));
    return {
      origin: paired.origin + "/?setup=linux-web2",
      pairingCode,
      runtime: { close: closeSetup },
      shutdownService: () =>
        (serviceStop ??= (async () => {
          // Stop explicit service ingress first; closing only setup never does so.
          await installation.shutdownService();
          await closeSetup();
          await inputs.closeControl();
        })().catch((error) => {
          serviceStop = undefined;
          throw error;
        })),
    };
  } catch (error) {
    secret.fill(0);
    const cleanup = async () => {
      await installation.shutdownService();
      if (error instanceof PairedOperatorStartupFailure) await error.close();
      await inputs.closeControl();
    };
    try {
      await cleanup();
    } catch (failure) {
      throw new Web2ServiceStartupFailure([error, failure], cleanup);
    }
    throw error;
  }
}

export async function runWeb2Service(configurationFile: string) {
  const cancellation = new AbortController();
  let owner: { shutdownService(): Promise<void> } | undefined,
    stopping = false;
  let held: ReturnType<typeof setInterval> | undefined, finished!: () => void;
  const terminal = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const retain = () => {
    process.exitCode = 1;
    held ??= setInterval(() => {}, 60000);
    process.stderr.write(
      "Service still owns unresolved process custody. Correct the failure, then signal this same service to retry cleanup.\n",
    );
  };
  const stop = () => {
    cancellation.abort(Error("installed_service_shutdown"));
    if (!owner || stopping) return;
    stopping = true;
    void owner.shutdownService().then(
      () => {
        if (held) clearInterval(held);
        finished();
      },
      () => {
        stopping = false;
        retain();
      },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const config = await readPrivateJSON<Web2LocalInstallationConfiguration>(
      configurationFile,
      16 * 1024 ** 2,
    );
    try {
      const session = await launchWeb2LocalInstallation(
        config,
        cancellation.signal,
      );
      owner = session;
      if (cancellation.signal.aborted) stop();
      else {
        const port = Number(new URL(session.origin).port);
        process.stdout.write(
          forwardingOutput(
            sshForwardingHint(port, process.env),
            session.pairingCode,
          ),
        );
      }
    } catch (error) {
      if (!(error instanceof Web2ServiceStartupFailure)) throw error;
      owner = error;
      retain(); // Do not discard the still-reachable startup child.
    }
    // Foreground ownership survives both setup closure and failed shutdown.
    // A failed cleanup waits for an explicit signal; it does not retry/spawn.
    await terminal;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert(
    process.argv.length === 3 && process.argv[2]?.startsWith("/"),
    "supply_private_web2_service_configuration",
  );
  await runWeb2Service(process.argv[2]);
}
