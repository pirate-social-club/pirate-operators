#!/usr/bin/env node
/** Explicit persistent host-service entrypoint. Closing the paired setup is
 * separate from stopping this service. No detach, systemd mutation or adoption. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { digest } from "../../packages/protocol/index.ts";
import {
  canonicalDigest,
  readPrivateJSON,
  verifyRecord,
  type SignedRecord,
  type TrustAnchor,
} from "./installed-records.ts";
import {
  verifyWeb2BootstrapRelease,
  installedExecutionPaths,
  type Web2BootstrapRelease,
} from "./installed-release.ts";
import { hash, privateDirectory } from "./backend-state.ts";
import { isNativePublicationActivityRoute, type NativePublicationActivityRoute } from "./web2-native-publication-host.ts";
import { assertNativePublicationHost, nativePublicationHostSelection, type Web2PublicationActivation, type Web2PublicationPreparation } from "./web2-publication-installation.ts";
import { publicIngressFrom } from "./public-ingress.ts";
import { startWeb2NativeActivityHost, type Web2NativeActivityHostInputs } from "./web2-native-activity-host.ts";
import {
  startPairedOperator,
  PairedOperatorStartupFailure,
  type PairedOperatorRuntime,
  type PairedOperatorInputs,
} from "./bootstrap-local-target.ts";
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

import { selectWeb2DancePublication, selectWeb2PublicationConsent } from "./web2-initialization.ts";
import { trustedRevisionTwo } from "./web2-trusted-revision-two.ts";
import type { Web2TrustedRevisionTwoBinding } from "./web2-expanded-publication.ts";
import { produceTrustedRevisionTwoApproval, type Web2TrustedRevisionTwoIssuer } from "./web2-trusted-revision-two-producer.ts";
import type { Web2PublicDanceServeCustody } from "./web2-public-dance-custody.ts";
import type { Web2DanceActivationOwner } from "./web2-dance-retained-activation.ts";
import type { Web2DanceBindPrepareOwner } from "./web2-dance-bind-prepare.ts";

export interface Web2LocalInstallationConfiguration {
  schema: "pirate.web2-local-installation/1";
  release: SignedRecord<Web2BootstrapRelease>;
  trust: TrustAnchor;
  runtimeProfileFile: string;
}
/** W1 supplies the Wizard implementation; this module owns the paired transport. */
export interface Web2BootstrapInputs {
  binding: Web2RuntimeBindingInputs;
  activityHost?: Web2NativeActivityHostInputs;
  publicationActivity?: NativePublicationActivityRoute;
  /** Selected owner bootstrap runs only inside the reviewed install apply. */
  prepareExpandedPublication?(input: Web2PublicationPreparation): Promise<void>;
  /** Fresh fixture owner opens the genuine route only after its admitted
   * expanded plan and selector are staged. It keeps the returned Store alive
   * until the existing closeControl, after the listener drains. */
  openExpandedPublication?(input: Web2PublicationActivation): Promise<NativePublicationActivityRoute>;
  /** Ordinary public ACME, after the signed retained rev2 approval and companion.
   * The installed owner opens openWeb2PublicationTransport using the exact
   * original, selection, lease, issuer capability and operator Store. */
  openTrustedRevisionTwoPublication?(input: Web2PublicationActivation): Promise<NativePublicationActivityRoute>;
  startExpandedFirstGrant?(): void;
  drainExpandedFirstGrant?(): Promise<void>;
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
export function createWeb2SetupLifetime(signal?: AbortSignal) {
  let closed = false, busy = false;
  let idle = Promise.resolve();
  async function exclusive<T>(action: () => Promise<T>) {
    assert(!closed && !signal?.aborted && !busy, "web2_setup_closed_or_busy");
    busy = true;
    const active = Promise.withResolvers<void>();
    idle = active.promise;
    try {
      return await action();
    } finally {
      busy = false;
      active.resolve();
    }
  }
  return {
    exclusive,
    running(afterRunning?: () => void) {
      if (!closed && !signal?.aborted) afterRunning?.();
    },
    closeSetup() {
      assert(!busy, "web2_setup_operation_not_quiescent");
      closed = true;
    },
    async shutdown(stop: () => Promise<void>, drain?: () => Promise<void>) {
      // Close admission before waiting: an in-flight activation can finish
      // owning its resources but cannot start a new first-grant run.
      closed = true;
      await idle;
      await drain?.();
      await stop();
    },
  };
}

/** The public four-method port is available before enrollment exists. Only its
 * prepare method may bind the real persisted enrollment to a strict runtime. */
export async function createWeb2BootstrapInstallation(
  inputs: Web2RuntimeBindingInputs,
  signal?: AbortSignal,
  afterRunning?: () => void,
) {
  const binder = await createWeb2RuntimeBinder(inputs);
  const lifetime = createWeb2SetupLifetime(signal);
  let installation: Web2InstalledService | undefined;
  const port: LinuxWeb2Installation = {
    ...(binder.privateStudyAvailable ? { privateStudyAvailable: true } : {}),
    ...(binder.privatePracticeSelection ? { privatePracticeSelection: binder.privatePracticeSelection } : {}),
    prepare: (value) =>
      lifetime.exclusive(async () => {
        const draft = linuxWeb2DraftFrom(value);
        const host = await binder.bind(draft);
        installation ??= await createWeb2Installation(host, signal);
        return installation.prepare(draft);
      }),
    apply: (selection) =>
      lifetime.exclusive(async () => {
        assert(installation, "original_web2_runtime_unavailable");
        assert(await binder.retained(),"original_web2_runtime_unavailable");
        const current = await installation.apply(selection);
        if (current.state === "running") lifetime.running(afterRunning);
        return current;
      }),
    verifyExpandedPublishing: (selection, draft) =>
      lifetime.exclusive(async () => {
        const expanded = await installation?.verifyExpandedPublishing?.(selection, draft);
        if (expanded) {
          // The binder rechecks the exact attached grant under the authenticated expanded configuration.
          assert(await binder.retained(), "original_web2_runtime_unavailable");
        }
        return expanded;
      }),
    status: (selection) =>
      lifetime.exclusive(async () => {
        assert(installation, "original_web2_runtime_unavailable");
        assert(await binder.retained(),"original_web2_runtime_unavailable");
        return installation.status(selection);
      }),
    async close() {
      lifetime.closeSetup();
      await installation?.close();
    },
  };
  return {
    port,
    resumeOriginal: () => lifetime.exclusive(async () => {
      const host = await binder.retained();
      if (host) {
        installation = await createWeb2Installation(host, signal);
        const current = await installation.resumeOriginal();
        if (current?.state === "running") lifetime.running(afterRunning);
      }
    }),
    shutdownService: (drain?: () => Promise<void>) => lifetime.shutdown(async () => {
      await installation?.shutdownService();
    }, drain),
  };
}
export class Web2ServiceStartupFailure extends AggregateError {
  readonly shutdownService: () => Promise<void>;
  constructor(errors: unknown[], shutdownService: () => Promise<void>) {
    super(errors, "web2_service_startup_custody_retained");
    this.shutdownService = shutdownService;
  }
}
async function selectInstalledWeb2Host(config: Web2LocalInstallationConfiguration) {
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
  return { runtime, execution, release, selected };
}

export interface Web2TrustedRevisionTwoApprovalHostInputs {
  binding: Web2TrustedRevisionTwoBinding;
  issue: Web2TrustedRevisionTwoIssuer;
  closeControl(): Promise<void>;
}

/** Separate owner command. The signed installed backend supplies only the
 * original host lease and record issuer for this action. It opens no Wizard,
 * native app, managed Workers or bootstrap/resume path. */
async function runWeb2TrustedRevisionTwoApproval(configurationFile: string) {
  const config = await readPrivateJSON<Web2LocalInstallationConfiguration>(configurationFile, 16 * 1024 ** 2);
  const { runtime, execution, release, selected } = await selectInstalledWeb2Host(config);
  assert(import.meta.url === pathToFileURL(execution.main).href &&
    release.sourceHashes["deploy/linux/web2-trusted-revision-two-producer.ts"],
    "installed_trusted_revision_two_producer_required");
  const loaded: {
    createWeb2TrustedRevisionTwoApprovalInputs?(): Promise<Web2TrustedRevisionTwoApprovalHostInputs>;
  } = await import(pathToFileURL(execution.backend).href);
  assert(typeof loaded.createWeb2TrustedRevisionTwoApprovalInputs === "function",
    "trusted_revision_two_host_issuer_unavailable");
  const inputs = await loaded.createWeb2TrustedRevisionTwoApprovalInputs();
  let digest: string;
  try {
    assert(canonicalDigest(inputs.binding.bootstrap) === canonicalDigest(config.release) &&
      canonicalDigest(inputs.binding.trust) === canonicalDigest(config.trust) &&
      inputs.binding.lease.installationId === runtime.installationId && typeof inputs.issue === "function",
      "trusted_revision_two_backend_changed");
    assert.deepEqual(await readPrivateJSON(config.runtimeProfileFile), selected, "web2_launch_selection_changed");
    digest = await produceTrustedRevisionTwoApproval(inputs.binding, inputs.issue.bind(inputs));
  } catch (error) {
    try { await inputs.closeControl(); }
    catch (failure) { throw new AggregateError([error, failure], "trusted_revision_two_control_custody_retained"); }
    throw error;
  }
  await inputs.closeControl();
  process.stdout.write(JSON.stringify({ approvalSha256: digest }) + "\n");
}

export interface Web2RetainedDanceActivationHostInputs {
  binding: Web2RuntimeBindingInputs;
  owner?: Web2DanceActivationOwner;
  prepareOwner?: Web2DanceBindPrepareOwner;
  closeControl(): Promise<void>;
}

/** A separate explicit private action under the original installation control.
 * The existing Workerd app must still be serving the primary application. */
async function runWeb2RetainedDanceOwnerAction(configurationFile: string, action: "stage" | "prepare") {
  const config = await readPrivateJSON<Web2LocalInstallationConfiguration>(configurationFile, 16 * 1024 ** 2);
  const { runtime, execution, release, selected } = await selectInstalledWeb2Host(config);
  assert(import.meta.url === pathToFileURL(execution.main).href &&
    release.sourceHashes["deploy/linux/web2-dance-retained-activation.ts"],
    "installed_web2_dance_activation_required");
  if (action === "prepare") {
    for (const path of [
      "deploy/linux/web2-dance-bind-prepare.ts", "packages/community/web2-dance-bind-intent.ts",
      "services/linux-web2-dance-bind-prepare.ts", "services/web2-installed-dance-bind-prepare.ts",
    ]) assert(Object.hasOwn(release.sourceHashes, path), "installed_web2_dance_bind_prepare_required");
  }
  const loaded: {
    createWeb2RetainedDanceActivationInputs?(): Promise<Web2RetainedDanceActivationHostInputs>;
  } = await import(pathToFileURL(execution.backend).href);
  assert(typeof loaded.createWeb2RetainedDanceActivationInputs === "function", "web2_dance_activation_owner_unavailable");
  const inputs = await loaded.createWeb2RetainedDanceActivationInputs();
  let receipt: { scopeSha256: string } | Awaited<ReturnType<Web2InstalledService["prepareRetainedDanceBindings"]>>;
  let installation: Web2InstalledService | undefined;
  async function close() {
    await installation?.shutdownService();
    await inputs.closeControl();
  }
  try {
    assert(canonicalDigest(inputs.binding.bootstrap) === canonicalDigest(config.release) &&
      canonicalDigest(inputs.binding.trust) === canonicalDigest(config.trust) &&
      inputs.binding.lease.installationId === runtime.installationId, "installed_web2_backend_changed");
    assert.deepEqual(await readPrivateJSON(config.runtimeProfileFile), selected, "web2_launch_selection_changed");
    const binder = await createWeb2RuntimeBinder(inputs.binding, "retained-dance-owner");
    const retained = await binder.retainedForDanceOwnerAction();
    await retained.assertRetained();
    if (action === "stage") {
      assert(inputs.owner, "web2_dance_activation_owner_unavailable");
      installation = await createWeb2Installation(retained.host, undefined, retained.assertRetained);
      receipt = { scopeSha256: await installation.stageRetainedDance(inputs.owner, retained.assertRetained) };
    } else {
      assert(inputs.prepareOwner && typeof inputs.prepareOwner.approvedIntent === "function",
        "web2_dance_bind_prepare_owner_unavailable");
      installation = await createWeb2Installation(retained.host, undefined, retained.assertRetained);
      receipt = await installation.prepareRetainedDanceBindings(inputs.prepareOwner, retained.assertRetained);
    }
  } catch (error) {
    try { await close(); }
    catch (failure) { throw new AggregateError([error, failure], "web2_dance_activation_control_retained"); }
    throw error;
  }
  await close();
  process.stdout.write(JSON.stringify(receipt) + "\n");
}

export async function launchWeb2LocalInstallation(
  config: Web2LocalInstallationConfiguration,
  signal?: AbortSignal,
) {
  const { runtime, execution, release, selected } = await selectInstalledWeb2Host(config);
  for (const path of [runtime.wizardDirectory, runtime.pairingNonceDirectory])
    await privateDirectory(path);
  const loaded: { createWeb2BootstrapInputs(): Promise<Web2BootstrapInputs> } =
    await import(pathToFileURL(execution.backend).href);
  assert(
    typeof loaded.createWeb2BootstrapInputs === "function",
    "genuine_web2_installed_backend_required",
  );
  const inputs = await loaded.createWeb2BootstrapInputs();
  let nativeActivityHost: Awaited<ReturnType<typeof startWeb2NativeActivityHost>> | undefined;
  const installation = await (async () => {
    try {
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
      const policy = verifyRecord(inputs.binding.policy, config.trust);
      const publication = inputs.publicationActivity;
      const prepare = inputs.prepareExpandedPublication?.bind(inputs);
      const activate = inputs.openExpandedPublication?.bind(inputs);
      const startFirstGrant = inputs.startExpandedFirstGrant?.bind(inputs);
      const drainFirstGrant = inputs.drainExpandedFirstGrant?.bind(inputs);
      const ports = inputs.binding.publication;
      const openTrusted = inputs.openTrustedRevisionTwoPublication?.bind(inputs);
      const trusted = policy.graph.publicationExpansion === trustedRevisionTwo;
      const trustedConsent = trusted && Boolean(policy.graph.nativePublication);
      assert(!inputs.binding.activateTrustedPublication &&
        (trusted ? Boolean(openTrusted) === trustedConsent && !publication && !ports &&
          !prepare && !activate && !startFirstGrant && !drainFirstGrant :
          !openTrusted && Boolean(policy.graph.nativePublication) === Boolean(publication || activate) &&
          Boolean(publication || activate) === Boolean(ports) && !(publication && activate) &&
          !ports?.prepareExpansion && !ports?.activateAfterStaging && Boolean(prepare) === Boolean(activate) &&
          Boolean(activate) === Boolean(startFirstGrant) && Boolean(activate) === Boolean(drainFirstGrant) &&
          (!activate || policy.graph.publicationExpansion === "registry-revision-two/1" && policy.graph.fixtureTransport)),
        "native_publication_host_unavailable");
      if (trustedConsent) nativePublicationHostSelection(policy);
      function checkRoute(route: NativePublicationActivityRoute) {
        assert(isNativePublicationActivityRoute(route), "native_publication_host_unavailable");
        assertNativePublicationHost(policy, route, inputs.binding.lease);
      }
      if (publication) checkRoute(publication);
      if (ports || openTrusted) {
        const bytes = await readFile(join(release.root, "migration-plan.json"));
        assert(hash(bytes) === release.files["migration-plan.json"], "native_publication_migrations_changed");
        const plan = JSON.parse(bytes.toString("utf8"));
        const names: string[] = plan.migrations.map((row: {name: string}) => row.name);
        const consent = names.indexOf("0020_publication_consent.sql");
        assert(consent >= 0 && names[consent + 1] === "0021_publication_installed_selection.sql",
          "native_publication_migrations_unavailable");
        if (trustedConsent) {
          assert(selectWeb2PublicationConsent(plan.migrations), "native_publication_migrations_unavailable");
          const dancePublication = Boolean(policy.graph.danceRewardIntent);
          assert(!dancePublication || selectWeb2DancePublication(plan.migrations), "native_dance_publication_migrations_unavailable");
          for (const row of plan.migrations.slice(consent, consent + (dancePublication ? 4 : 2))) {
            assert(hash(row.sql) === row.sha256 && row.statements.join("") === row.sql &&
              (!dancePublication || release.files["sql/" + row.name] === row.sha256),
              "native_publication_migrations_changed");
          }
        }
        await inputs.binding.lease.assertHeld();
        const now = Date.now();
        assert(Number.isSafeInteger(policy.issuedAt) && Number.isSafeInteger(policy.expiresAt) &&
          policy.issuedAt <= now && now < policy.expiresAt && !signal?.aborted, "native_publication_host_expired");
      }
      let stagedRoute: NativePublicationActivityRoute | undefined;
      let originalActivation: { identity: string; task: Promise<void> } | undefined;
      const opener = openTrusted ?? activate;
      function openSelectedPublication(input: Web2PublicationActivation, custody?: Web2PublicDanceServeCustody) {
        assert(opener, "native_publication_host_unavailable");
        const expectedDance = custody ? structuredClone(custody) : undefined;
        assert(!expectedDance || openTrusted, "native_dance_custody_unavailable");
        const identity = canonicalDigest({ original: input.original, selection: input.selection,
          selectionSha256: input.selectionSha256, ...(expectedDance ? { dance: expectedDance } : {}) });
        if (originalActivation) {
          assert(originalActivation.identity === identity, "native_expanded_publication_activation_changed");
          return originalActivation.task;
        }
        const task = (async () => {
          await input.assertCurrent();
          const route = await opener({
            original: structuredClone(input.original),
            selection: structuredClone(input.selection),
            selectionSha256: input.selectionSha256,
            assertCurrent: input.assertCurrent,
          });
          checkRoute(route);
          if (openTrusted) {
            const { entries, active } = input.selection;
            assert(!route.firstGrantSelected && route.retainedSelectionSha256 === digest({ entries, active }),
              "trusted_web2_publication_host_selection_changed");
          }
          await input.assertCurrent();
          if (expectedDance) {
            await route.assertRetainedDanceCustody(expectedDance.record.scope, expectedDance.record);
            await input.assertCurrent();
          }
          signal?.throwIfAborted();
          stagedRoute = route;
        })();
        originalActivation = { identity, task };
        return task;
      }
      const binding = openTrusted ? { ...inputs.binding, activateTrustedPublication: openSelectedPublication } :
        prepare && activate && ports ? { ...inputs.binding, publication: {
          ...ports, prepareExpansion: prepare, activateAfterStaging: openSelectedPublication,
        } } : inputs.binding;
      if (policy.nativeActivities) {
        assert(policy.privateStudy && inputs.activityHost && policy.installationId === runtime.installationId &&
          policy.target.installationId === runtime.installationId && Date.now() < policy.expiresAt && !signal?.aborted &&
          policy.bootstrapArtifactDigest === release.artifactDigest && policy.bootstrapSourceDigest === release.sourceDigest,
          "native_activity_bootstrap_scope_required");
        nativeActivityHost = await startWeb2NativeActivityHost({selected:policy.nativeActivities,study:policy.privateStudy,
          host:structuredClone(inputs.activityHost), ingress:publicIngressFrom(policy.ingress),
          stateRoot:policy.target.stateRoot,lease:inputs.binding.lease,publication,
          ...(opener ? { deferredPublication: () => stagedRoute } : {})});
      } else assert(!inputs.activityHost, "unselected_activity_host_refused");
      return await createWeb2BootstrapInstallation(binding, signal, startFirstGrant);
    } catch (error) {
      const cleanup = async () => { await nativeActivityHost?.close(); await inputs.closeControl(); };
      try { await cleanup(); } catch (failure) { throw new Web2ServiceStartupFailure([error,failure],cleanup); }
      throw error;
    }
  })();
  const secret = randomBytes(32);
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
          // Close setup and drain the owned attempt while the app proof and activity listener still exist.
          await installation.shutdownService(inputs.drainExpandedFirstGrant?.bind(inputs));
          await closeSetup();
          await nativeActivityHost?.close();
          await inputs.closeControl();
        })().catch((error) => {
          serviceStop = undefined;
          throw error;
        })),
    };
  } catch (error) {
    secret.fill(0);
    const cleanup = async () => {
      await installation.shutdownService(inputs.drainExpandedFirstGrant?.bind(inputs));
      if (error instanceof PairedOperatorStartupFailure) await error.close();
      await nativeActivityHost?.close();
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
      else
        process.stdout.write(
          "Open " +
            session.origin +
            "\nPrivate pairing code: " +
            session.pairingCode +
            "\n",
        );
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
  const args = process.argv.slice(2);
  if (args[0] === "--approve-trusted-revision-two") {
    assert(args.length === 2 && args[1]?.startsWith("/"), "supply_private_web2_service_configuration");
    await runWeb2TrustedRevisionTwoApproval(args[1]);
  } else if (args[0] === "--stage-retained-dance" || args[0] === "--prepare-retained-dance-bindings") {
    assert(args.length === 2 && args[1]?.startsWith("/"), "supply_private_web2_service_configuration");
    await runWeb2RetainedDanceOwnerAction(args[1], args[0] === "--stage-retained-dance" ? "stage" : "prepare");
  } else {
    assert(args.length === 1 && args[0]?.startsWith("/"), "supply_private_web2_service_configuration");
    await runWeb2Service(args[0]);
  }
}
